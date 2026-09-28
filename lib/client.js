// dsh-paste-spill — web client half (`exports["./client"]` of the single
// dsh-paste-spill package; discovered through `dsh.client` in its package.json).
// The host half lives in lib/index.js of the same package.
//
// Inbound large-paste handling for the composer:
//   * >= 50000 UTF-8 bytes -> synthesize a File and ride the existing attachment
//     upload path, so the message carries a legal `file` block and dsh-llm hands
//     the model a read-only host path with no format change anywhere.
//   * >= 4000 bytes -> replace JUST that pasted run with a reference chip in the
//     editor and hold its text by ref. One paste, one chip: several can coexist,
//     each expandable and deletable on its own.
//
// Module format: window.__ModuleLoader__ factory bundle (see
// @deepseek-ai/dsh-client-modules). Pure JS plus require("react"), ships as-is.

window.__ModuleLoader__.load({
  // The module id MUST be the package name: the browser loader registers the bundle
  // under the name it was asked for, and the host scanner serves it under the row's
  // package. Same convention as dsh-image-gen / dsh-message-rail.
  id: "dsh-paste-spill",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");

    /** Fold at this many UTF-8 bytes: pure UI hint, zero semantic change. */
    const FOLD_BYTES = 4000;
    /** Spill at this many bytes: the text becomes a real file attachment. */
    const SPILL_BYTES = 50000;
    /** Filename prefix for a spilled paste. */
    const PASTE_NAME_PREFIX = "pasted-text-";
    const NS = "dsh-paste-spill";
    /** The composer's contenteditable surface — how we recognize paste targets. */
    const COMPOSER_SELECTOR = "[data-composer-input]";
    /**
     * The `source` name our fold chips register under.
     *
     * It is ALSO the value stock stamps on each chip's DOM node
     * (`data-composer-chip="<source>"`, ReferenceChipNode.createDOM), which is what
     * the stylesheet uses to hide the native chip face. That hook is stable, unlike
     * the CSS-module class hash (`eMFGQq_chip` in this build) which changes with
     * every app build — the previous stylesheet keyed on a hash from an older build
     * and therefore hid nothing at all.
     */
    const FOLD_SOURCE = "folded-text";
    /** Breathing room between the floating chip band and the composer's first line. */
    const CHIP_BAND_GAP = 8;
    /** Bumped by hand so the boot marker identifies the exact build in the GUI. */
    const BUILD_REV = "merged-7";
    /** Debug channel. The renderer partition's Local Storage is readable from the
     * host, so this is the only way to get in-app ground truth without a console. */
    const DIAG_KEY = "dsh.paste-spill.diag";

    function diag(patch) {
      try {
        const raw = window.localStorage.getItem(DIAG_KEY);
        const next = raw === null ? {} : JSON.parse(raw);
        // Clear the failure-reason key whenever a chip outcome is reported.
        //
        // `diag` merges, so a reason recorded by one attempt survives into every
        // later snapshot and reads as if it were current. That misled a real
        // debugging session: after the #337 timing fix the reason still showed #337
        // while the insert had in fact succeeded. A reason is only meaningful beside
        // the outcome it explains, so reporting an outcome retires it.
        if ("foldChipInserted" in patch || "foldChipDeferred" in patch) next.foldChipReason = undefined;
        Object.assign(next, patch);
        window.localStorage.setItem(DIAG_KEY, JSON.stringify(next));
      } catch {
        /* diagnostics must never break the paste path */
      }
    }

    /**
     * Per-session diagnostics, because "it works in one conversation but not in
     * another" is not answerable from a flat map.
     *
     * The flat `diag` merges every writer into one object, so `tick`/`watchOk`/
     * `foldChipReason` show the LAST writer of each key no matter which session it
     * came from — reading them across a session switch produced a timeline that
     * looked impossible (a tick counter that appeared to go backwards). Facts that
     * decide whether a session can fold are session facts, so they are recorded per
     * session id here and merged into the same Local Storage value.
     *
     * Bounded: the last few sessions are kept, newest last, so an afternoon of
     * session switching cannot grow the value without limit.
     */
    const SESSION_DIAG_MAX = 8;
    const sessionDiag = {};
    const sessionDiagOrder = [];

    function diagSession(sessionId, patch) {
      if (sessionId === undefined || sessionId === null || sessionId === "") return;
      try {
        const sid = String(sessionId);
        const record = sessionDiag[sid] === undefined ? {} : sessionDiag[sid];
        for (const key of Object.keys(patch)) {
          if (patch[key] === undefined) delete record[key];
          else record[key] = patch[key];
        }
        sessionDiag[sid] = record;
        const at = sessionDiagOrder.indexOf(sid);
        if (at >= 0) sessionDiagOrder.splice(at, 1);
        sessionDiagOrder.push(sid);
        while (sessionDiagOrder.length > SESSION_DIAG_MAX) delete sessionDiag[sessionDiagOrder.shift()];
        diag({ bySession: sessionDiag });
      } catch {
        /* diagnostics must never break the paste path */
      }
    }

    /** Increment one per-session counter and report its new value. */
    function bumpSession(sessionId, key) {
      if (sessionId === undefined || sessionId === null || sessionId === "") return 0;
      const record = sessionDiag[String(sessionId)];
      const next = (record === undefined || typeof record[key] !== "number" ? 0 : record[key]) + 1;
      diagSession(sessionId, { [key]: next });
      return next;
    }

    /**
     * Record only transitions worth investigating.
     *
     * Deliberately NOT a per-keystroke diagnostic: Local Storage writes are
     * synchronous and this runs inside the draft subscriber, so writing on every
     * character would add real typing latency. Only fold/spill verdicts and
     * spill-sized insertions are news; anything else is dropped. Once this code
     * path is confirmed working the whole diagnostic layer can be deleted.
     */
    let transitionCount = 0;
    function noteTransition(decision, runBytes) {
      if (decision === "inline" && runBytes < SPILL_BYTES) return;
      transitionCount += 1;
      diag({ transitionCount, lastDecision: decision, lastRunBytes: runBytes, lastTransitionAt: Date.now() });
    }

    /**
     * Describe a composer draft for the diagnostics, without dumping its text.
     *
     * The exact SHAPE matters and is not visible from an outcome field alone. Stock's
     * `insertReference` appends a trailing SPACE after the chip whenever the character
     * following the span is not already one, so a chip fold's draft settles to
     * `"\uFFFC "` -- TWO code units, not one. Several earlier bugs were misdiagnosed
     * because a stub modelled it as a single unit, so record the real shape: the code
     * units, the length, and how many placeholders and spaces are present.
     */
    function describeDraft(draft) {
      if (typeof draft !== "string") return { kind: typeof draft };
      return {
        length: draft.length,
        chipCount: (draft.match(/\uFFFC/g) ?? []).length,
        spaceCount: (draft.match(/ /g) ?? []).length,
        newlineCount: (draft.match(/\n/g) ?? []).length,
        // A compact, text-free fingerprint: placeholders and whitespace only, so the
        // user's actual content never lands in Local Storage.
        shape: draft.replace(/[^\uFFFC \n]/gu, "").slice(0, 40),
        // The literal content of a SHORT draft, so an unexpected settled shape can be
        // read directly rather than inferred. Bounded to a length no user paste can
        // reach, so real content never lands in Local Storage.
        shortLiteral: draft.length <= 24 ? draft : undefined,
      };
    }

    const zh = {
      // Shown only when the preview is unavailable (a whitespace-only paste).
      foldTitle: "已折叠大文本",
      // The affordance line, matching the reference chip's "在文本框中显示 ›".
      foldExpandAction: "在文本框中显示",
      foldDismissLabel: "删除这段文本",
      foldHint: "点击展开全文到输入框 · 提交时按原样发送",
    };
    const en = {
      foldTitle: "Large text folded",
      foldExpandAction: "Show in text box",
      foldDismissLabel: "Delete this text",
      foldHint: "Click to expand into the text box · sent as-is",
    };

    /** UTF-8 byte length — the one measurement all thresholds use. */
    function utf8Bytes(text) {
      return new TextEncoder().encode(text).byteLength;
    }

    /** Route one paste by its measured size. */
    function decidePaste(text, foldBytes = FOLD_BYTES, spillBytes = SPILL_BYTES) {
      const bytes = utf8Bytes(text);
      if (bytes >= spillBytes) return { action: "file", bytes };
      if (bytes >= foldBytes) return { action: "fold", bytes };
      return { action: "inline", bytes };
    }

    /** Line count for the fold card's metadata. */
    function countLines(text) {
      return String(text).split("\n").length;
    }

    /**
     * Light content sniffing so a pasted code block keeps an honest extension.
     * Guessing wrong only costs syntax highlighting, never correctness.
     */

    function pasteFileName(text, index) {
      const body = String(text);
      let ext = "txt";
      if (/^\s*[{[]/.test(body) && /[}\]]\s*$/.test(body)) ext = "json";
      else if (/^```/.test(body.trimStart()) || /^#{1,6} /m.test(body)) ext = "md";
      else if (/^\s*(def |class |import |from \w+ import )/m.test(body)) ext = "py";
      else if (/\b(function |const |let |=>|import .* from )/.test(body)) ext = "js";
      else if (/^\s*<[a-zA-Z][\s\S]*>\s*$/.test(body)) ext = "html";
      else if (/^[\w.-]+,[\w.-]+/m.test(body) && body.includes(",")) ext = "csv";
      return `${PASTE_NAME_PREFIX}${index}.${ext}`;
    }

    /**
     * Is the folded text still in the draft, judged by the record's own sentinels?
     *
     * A record is stale once NONE of its sentinels appear in the draft any more.
     * Requiring any-one-of rather than all-of keeps the record alive through
     * editor normalization (which may drop one sentinel) while still clearing it
     * when the text is genuinely gone.
     */
    function foldTextPresent(record, draft) {
      if (record === undefined || record === null) return false;
      if (typeof draft !== "string" || draft === "") return false;
      const sentinels = Array.isArray(record.sentinels) ? record.sentinels : [];
      if (sentinels.length === 0) return false;
      return sentinels.some((candidate) => typeof candidate === "string" && candidate !== "" && draft.includes(candidate));
    }



    /**
     * Yield for one task turn, so queued editor commits can apply.
     *
     * Used between chip-insert attempts. A macrotask, not a microtask: the editor's
     * commit queue runs off the task queue, so a microtask would re-read the projection
     * before those commits have drained and observe the same stale revision. Resolves
     * false when no task queue is available (a bare test harness), which stops the retry
     * loop instead of hanging.
     *
     * @returns a promise resolving true when a turn elapsed.
     */
    function settleTurn() {
      if (typeof setTimeout !== "function") return Promise.resolve(false);
      return new Promise((resolve) => { setTimeout(() => resolve(true), 0); });
    }

    /**
     * Text held by fold chips, keyed by the `ref` the chip carries.
     *
     * Why a module-level map rather than session state: the ONLY value that
     * crosses from an inserted chip into the submitted message is its `ref`
     * (stock calls `occurrences[].serializeReference(source, ref)` at submit
     * time). So `ref` is the handle the serializer dereferences, and it must
     * outlive the React render tree that inserted it.
     */
    const foldTextByRef = new Map();

    /**
     * Hold text under the `ref` a fold chip carries.
     *
     * The ref is minted by the plugin and embedded in the chip node, so this is the
     * only handle the serializer will later have. Re-holding an existing ref is a
     * programming error, not a user-visible condition.
     * @param ref - chip reference id.
     * @param text - the original pasted text.
     */
    function holdFoldText(ref, text) {
      foldTextByRef.set(ref, text);
    }

    /**
     * Release held text, so a later serialize of the same ref fails loudly.
     *
     * Called by both exits from a fold: expanding (the text is back in the editor,
     * so the chip is gone) and × (the user discarded it). Failing loudly matters --
     * returning "" would silently submit a truncated message.
     * @param ref - chip reference id.
     */
    function releaseFoldText(ref) {
      foldTextByRef.delete(ref);
    }

    /**
     * Format a byte count for the chip's label.
     */
    function formatFoldSize(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      const kb = bytes / 1024;
      if (kb < 1000) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
      return `${(kb / 1024).toFixed(1)} MB`;
    }

    /**
     * Every fold entry a record holds, oldest first.
     *
     * A record is `{ folds: [...], <newest entry fields> }`: the list is the truth and
     * the top-level fields alias the newest entry so a single-fold consumer (and the
     * diagnostics) can still read `record.text` / `record.chipRef`. A bare entry is
     * also accepted, which is what the previous build wrote.
     *
     * One paste = one entry = one chip. That is the whole point of the list: the
     * previous build kept ONE record per session, so a second large paste overwrote
     * the first fold instead of adding to it.
     */
    function foldEntries(record) {
      if (record === null || record === undefined) return [];
      if (Array.isArray(record.folds)) {
        return record.folds.filter((entry) => entry !== null && entry !== undefined);
      }
      return [record];
    }

    /** Publish a fold list as a record whose top-level fields alias the newest entry. */
    function foldRecord(folds) {
      const newest = folds.length === 0 ? {} : folds[folds.length - 1];
      return {
        folds,
        bytes: newest.bytes,
        lines: newest.lines,
        sentinels: newest.sentinels,
        text: newest.text,
        chipRef: newest.ref,
        chipInserted: newest.chipInserted === true,
      };
    }

    /**
     * The refs of OUR chips that are live in the editor right now, or null when the
     * projection cannot be read.
     *
     * This is the exact answer to "is this fold still on screen": stock's projection
     * lists every chip node with its `source` and `ref`, so a fold whose ref is gone
     * has been deleted (Backspace, or our own ×) and its entry must be retired. The
     * draft-text sentinel test cannot tell two identical chips apart -- two 6 KB
     * pastes produce the same label -- so it is only the fallback.
     */
    function liveFoldRefs(shell) {
      if (shell === null || shell === undefined) return null;
      const projection = shell.projection;
      if (projection === null || projection === undefined) return null;
      const occurrences = projection.occurrences;
      if (!Array.isArray(occurrences)) return null;
      const refs = new Set();
      for (const occurrence of occurrences) {
        if (occurrence === null || occurrence === undefined) continue;
        if (occurrence.source === FOLD_SOURCE && typeof occurrence.ref === "string") refs.add(occurrence.ref);
      }
      return refs;
    }

    /**
     * Detect-coordinate span of ONE of our chips, read from stock's own projection.
     *
     * Spans in this API are DETECT coordinates: a chip contributes exactly ONE
     * character (U+FFFC) to the detect projection while occupying its whole
     * `clipboardText` length in the draft, so the k-th chip's detect offset is its
     * clipboard offset minus one character for every earlier chip. With a single chip
     * that subtraction is zero, which is why the single-chip build never needed it —
     * and why using a CLIPBOARD offset as a detect span silently stopped working the
     * moment a real chip was in the draft.
     *
     * @returns `{start, end, draftRev}` or null when the ref is not in the editor.
     */
    function detectSpanOfRef(projection, ref, draftRev) {
      const occurrences = projection === null || projection === undefined ? undefined : projection.occurrences;
      if (!Array.isArray(occurrences)) return null;
      let delta = 0;
      for (const occurrence of occurrences) {
        if (occurrence === null || occurrence === undefined) continue;
        const length = typeof occurrence.length === "number" ? occurrence.length : 0;
        const offset = typeof occurrence.offset === "number" ? occurrence.offset : 0;
        const start = offset - delta;
        if (occurrence.source === FOLD_SOURCE && occurrence.ref === ref) {
          return { start, end: start + 1, draftRev };
        }
        delta += Math.max(0, length - 1);
      }
      return null;
    }

    /**
     * The detect span that the run a paste just inserted occupies.
     *
     * Why not `[0, draft.length)` like the single-chip build: that endpoint is a
     * CLIPBOARD offset, and the two projections diverge as soon as the composer holds
     * a chip, so the span overshot `detectLength`, `selectSpan` mapped nothing and
     * `insertReference` returned false. That is exactly why a SECOND large paste
     * stopped folding and left its text inline in the input box.
     *
     * The run is located from the live caret -- a paste leaves it collapsed at the end
     * of what it inserted -- and then verified against the detect projection, so a
     * stale span is refused instead of being applied to whatever now sits there.
     *
     * @returns `{start, end, draftRev}` or null when the run cannot be located.
     */
    function pastedRunSpan(shell, text, draftRev) {
      if (typeof text !== "string" || text === "") return null;
      if (typeof shell.caretSpan !== "function") return null;
      let caret = null;
      try {
        caret = shell.caretSpan();
      } catch {
        return null;
      }
      if (caret === null || caret === undefined) return null;
      const end = typeof caret.end === "number" ? caret.end : null;
      if (end === null || caret.start !== end) return null;
      const projection = shell.projection;
      const detect = projection === null || projection === undefined ? undefined : projection.detectText;
      // No projection to verify against (a bare harness, not the app): keep the old
      // caret span rather than refusing to fold at all.
      if (typeof detect !== "string") {
        const plain = normalizations(text).find((variant) => variant.length <= end);
        if (plain === undefined) return null;
        return { start: end - plain.length, end, draftRev, text: plain };
      }
      // THE EDITOR MAY REWRITE WHAT IT RECEIVED.
      //
      // The recording is the CLIPBOARD payload; the draft holds what the editor
      // actually inserted, and Lexical normalizes line endings on the way in (CRLF ->
      // LF) along with other control-character cleanups. Locating the run by
      // `end - text.length` then compares the wrong strings and the span is refused,
      // which is a silent "this paste did not fold" -- exactly the
      // content-dependent, session-dependent failure this check must not produce.
      // Every plausible rendering of the same payload is tried, and the variant that
      // really is in the draft is what the chip ends up holding, so expand restores
      // the text verbatim instead of a copy that never matched the editor.
      for (const variant of normalizations(text)) {
        const start = end - variant.length;
        if (start >= 0 && detect.slice(start, end) === variant) return { start, end, draftRev, text: variant };
      }
      // THE CARET IS NOT THE ONLY EVIDENCE, and it is the fragile part.
      //
      // The anchor above assumes the paste is still the last thing before the caret. One
      // keypress after a paste in a conversation that is still answering therefore made
      // the run unfindable, and the fold silently never happened -- reported in the app as
      // "some conversations show no chip". If a rendering occurs EXACTLY ONCE in the
      // editor, that occurrence is the pasted run no matter where the caret went. Two
      // occurrences are genuinely ambiguous and stay with the caret anchor.
      for (const variant of normalizations(text)) {
        const first = detect.indexOf(variant);
        if (first < 0) continue;
        if (detect.indexOf(variant, first + 1) >= 0) continue;
        diag({ foldRunLocatedBySearch: true, foldRunBytes: utf8Bytes(variant) });
        return { start: first, end: first + variant.length, draftRev, text: variant };
      }
      return null;
    }

    /**
     * The renderings a pasted payload may have in the editor, best guess first.
     *
     * Only normalizations an editor is known to apply are listed, and each is a
     * pure function of the clipboard text, so the located variant is always
     * something the user really pasted.
     */
    function normalizations(text) {
      const variants = [text];
      const lf = text.replace(/\r\n?/gu, "\n");
      if (lf !== text) variants.push(lf);
      const stripped = text.replace(/[\u200B-\u200D\uFEFF]/gu, "");
      if (stripped !== text) variants.push(stripped);
      const both = lf.replace(/[\u200B-\u200D\uFEFF]/gu, "");
      if (both !== text && !variants.includes(both)) variants.push(both);
      // Stock's own async-text insertion strips the placeholder/private-use range
      // (`\uE100-\uE11D`, `\uFFFC`), so a paste carrying one of those characters lands
      // in the editor without it. Unlisted, such a paste was neither foldable nor
      // removable -- and an unremovable spill is the wipe path above.
      const withoutPlaceholders = lf.replace(/[\uE100-\uE11D\uFFFC]/gu, "");
      if (withoutPlaceholders !== text && !variants.includes(withoutPlaceholders)) variants.push(withoutPlaceholders);
      const withoutPlaceholdersStripped = withoutPlaceholders.replace(/[\u200B-\u200D\uFEFF]/gu, "");
      if (withoutPlaceholdersStripped !== text && !variants.includes(withoutPlaceholdersStripped)) {
        variants.push(withoutPlaceholdersStripped);
      }
      return variants;
    }

    /**
     * Write over one chip's own detect span: its text to expand, "" to delete.
     *
     * There is no stock "remove this reference by ref" verb, so the chip is addressed
     * the way the editor addresses it internally -- as the one-character detect span
     * it occupies. `replaceText` with an empty string removes the selected node
     * outright, which is precisely what × must do; a non-empty string puts the paste
     * back where the chip was, which is precisely what expand must do.
     *
     * The write goes through the shell's action face when available (`insertAsyncText`
     * also strips the placeholder characters a pasted text may carry), and falls back
     * to the shell's own `insertText`.
     *
     * @returns true only when the editor accepted the edit.
     */
    /**
     * Replace ONE chip node with `text`, editing the document in place.
     *
     * In place is the whole point. `setDraft` would rebuild the composer from plain text
     * and destroy every other chip -- and a chip is the only carrier of its paste, so the
     * other pastes would be lost. This writes over exactly the one detect span instead, so
     * other chips, typed text, the caret and undo history all survive.
     *
     * `consumeSeparator` takes the space stock appended beside the chip (it adds one so
     * the composer stays typeable). Removing the chip without it would leave that space
     * behind -- a stray space in an "emptied" box after a dismiss, or one extra character
     * after an expand, where the requirement is that only the ORIGINAL text comes back. A
     * separator is only consumed when a space really is the next character.
     *
     * @returns true only when the editor accepted the write, so a failed expand can leave
     *   the chip on screen and retryable rather than clearing bookkeeping for nothing.
     */
    function writeOverChip({ shell, ref, text, consumeSeparator = false }) {
      if (shell === null || shell === undefined) return false;
      const snapshot = shell.state === undefined ? undefined : shell.state.getSnapshot();
      const rev = snapshot === undefined ? undefined : snapshot.draftRev;
      const projection = shell.projection;
      const span = detectSpanOfRef(projection, ref, rev);
      if (span === null || typeof rev !== "number") return false;
      const detect = projection === null || projection === undefined ? undefined : projection.detectText;
      const target =
        consumeSeparator && typeof detect === "string" && detect.slice(span.end, span.end + 1) === " "
          ? { start: span.start, end: span.end + 1, draftRev: rev }
          : span;
      const actions = shell.actions;
      const write = actions !== undefined && typeof actions.insertText === "function"
        ? (value) => actions.insertText(value, target)
        : typeof shell.insertText === "function"
          ? (value) => shell.insertText(value, target)
          : null;
      if (write === null) return false;
      try {
        return write(text) === true;
      } catch {
        return false;
      }
    }

    /**
     * Take one spilled paste's text out of the editor IN PLACE.
     *
     * The obvious implementation -- `removePastedText` on the draft, then `setDraft` --
     * is a REWRITE: the whole draft comes back as plain text, so every chip node in it is
     * destroyed and only its footprint (the label "已折叠 5.9 KB") survives as text. Found
     * in-app with the plainest possible sequence: paste 6 KB (chip), then paste 60 KB
     * (spill) -- the chip was gone and the label sat in the input box.
     *
     * A chip is the only carrier of its paste, so that rewrite is not a cosmetic bug. The
     * removal therefore targets ONE detect span, exactly like the chip insert does, and
     * every other node, the caret and the undo history are left alone.
     *
     * @returns "span" (edited in place), "draft" (string fallback), or "skipped".
     */
    function removePastedRunInPlace({ shell, text, run, current, previous }) {
      const snapshot = shell === null || shell === undefined || shell.state === undefined ? undefined : shell.state.getSnapshot();
      const rev = snapshot === undefined ? undefined : snapshot.draftRev;
      const actions = shell === null || shell === undefined ? undefined : shell.actions;
      const write = actions !== undefined && typeof actions.insertText === "function"
        ? actions.insertText.bind(actions)
        : typeof shell?.insertText === "function"
          ? shell.insertText.bind(shell)
          : null;
      if (write !== null && typeof rev === "number") {
        // The run is located the same way the chip insert locates it: at the caret, or --
        // when the user has typed since -- by being the only occurrence in the editor.
        let span = pastedRunSpan(shell, typeof text === "string" && text !== "" ? text : run, rev);
        if (span === null && typeof run === "string" && run !== "" && shell.projection !== undefined) {
          const detect = shell.projection === null ? undefined : shell.projection.detectText;
          if (typeof detect === "string") {
            const at = detect.indexOf(run);
            if (at >= 0 && detect.indexOf(run, at + 1) < 0) {
              span = { start: at, end: at + run.length, draftRev: rev, text: run };
            }
          }
        }
        if (span !== null) {
          try {
            if (write("", span) === true) {
              diag({ spillExcisedInPlace: true });
              return "span";
            }
          } catch {
            /* unaddressable span: the caller leaves the text inline */
          }
        }
        // THE EDITOR IS ADDRESSABLE BY SPAN, SO THERE IS NO STRING FALLBACK HERE.
        //
        // The string path below is a REWRITE (`setDraft`), which destroys every chip in
        // the draft -- the exact shape of the reported "paste 6K, paste 60K, the box shows
        // 已折叠 5.9 KB". When a span cannot be located the honest answer is "leave the
        // pasted text where it is": the attachment already holds it, and a second copy
        // inline is harmless.
        return "skipped";
      }
      // No editor actions to address a span with (a bare harness, not the app): the
      // draft-string path is the only option. `removePastedText` leaves the draft
      // untouched when it cannot locate the run, and that is honored as "skipped".
      const cleaned = removePastedText(
        typeof current === "string" ? current : "",
        text,
        previous,
      );
      if (cleaned === current) return "skipped";
      try {
        shell.setDraft(cleaned);
        return "draft";
      } catch {
        return "skipped";
      }
    }

    /**
     * Max characters of pasted content shown on the chip's preview line.
     *
     * 20 by request: the chip stays a compact single line, and a short preview is
     * enough to recognise the paste without the line turning into a wall of text.
     */
    const PREVIEW_CHARS = 20;

    /**
     * One-line preview of the folded text, for the chip's title.
     *
     * The reference chip shows the opening characters of the content rather than a
     * size summary, so the user can recognize WHAT was folded. Newlines and runs of
     * whitespace collapse to single spaces because the chip is one line tall and an
     * embedded newline would otherwise make the ellipsis meaningless.
     */
    function foldPreview(text) {
      if (typeof text !== "string" || text === "") return "";
      const flat = text.replace(/\s+/g, " ").trim();
      if (flat === "") return "";
      return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS)}\u2026`;
    }

    /**
     * The preview line for ONE fold record.
     *
     * Reads the record's own `text`, which always holds the text that fold owns -- the
     * text STAYS in the editor now, so the record is the only source needed. (An earlier
     * design had to fall back to a by-ref hold, because collapsing removed the text from
     * the draft; nothing is removed any more.)
     *
     * @param fold - one entry from `record.folds`.
     * @returns the flattened, truncated preview, or "" when there is nothing to show.
     */
    function foldPreviewOf(fold) {
      if (fold === null || fold === undefined) return "";
      return foldPreview(typeof fold.text === "string" ? fold.text : "");
    }

    /**
     * Register the `fold` chip source with stock's trigger pipeline.
     *
     * Why a chip at all, instead of clamping the text with CSS: a chip is the only
     * way to put something in the composer that is not literal text. The chip node
     * contributes a lone U+FFFC to the draft, and `"\uFFFC".trim() !== ""`, so
     * stock's `empty` test (`draft.trim() === "" && attachments.length === 0`) is
     * false and the send button stays LIVE -- while the real text stays out of the
     * composer and is re-serialized from `ref` at submit. That is exactly how
     * stock's own image and `@file` chips work, and it needs no stock patch.
     *
     * `trigger`/`name` must be unique in the roster (duplicates throw), so the
     * pair is namespaced with the plugin prefix.
     * @param ctx - client plugin context.
     */
    function registerFoldSource(ctx) {
      try {
        const inputTriggers = ctx.inputTriggers !== undefined ? ctx.inputTriggers : ctx.get("inputTriggers");
        if (inputTriggers === undefined || typeof inputTriggers.registerSource !== "function") {
          diag({ foldSourceRegistered: false, foldSourceReason: "service-missing" });
          return;
        }
        const source = {
          trigger: "\x00",
          name: FOLD_SOURCE,
          showGroupTitle: false,
          candidates() {
            return Promise.resolve([]);
          },
          codec: {
            // Declared for symmetry with stock sources; the shipped pipeline never
            // reads it (the per-chip clipboard text travels on the reference itself).
            clipboardText: (ref) => `[folded-text:${ref}]`,
            serialize(ref) {
              const held = foldTextByRef.get(ref);
              if (held === undefined) return Promise.reject(new Error(`dsh-paste-spill: folded text "${ref}" is no longer held`));
              diag({ foldSerializeBytes: utf8Bytes(held) });
              return Promise.resolve(held);
            },
          },
        };
        ctx.effect(() => inputTriggers.registerSource(source), "dsh-paste-spill: folded-text source");
        diag({ foldSourceRegistered: true });
      } catch (error) {
        diag({ foldSourceRegistered: false, foldSourceReason: String(error && error.message) });
      }
    }

    /**
     * Replace the run a paste just inserted with a ReferenceChipNode holding `text`
     * under `ref`, and carry the text in `foldTextByRef`.
     *
     * The span covers the RUN, never the whole draft. A whole-draft span would
     * swallow every earlier chip along with the new text, and those chips are the
     * only carriers of their pasted content -- replacing one loses that user's text.
     * (It also could not work: a whole-draft span is measured from the clipboard
     * projection, whose length no longer equals the detect length once a chip
     * exists, so `selectSpan` refused it outright.)
     *
     * The chip's draft footprint is its label text (e.g. "已折叠 5.9 KB"), not a
     * lone U+FFFC: stock's clipboard projection receives the chip's `clipboardText`,
     * and the watcher reads that same draft.
     *
     * @returns the chip's draft-footprint string on success, false on failure.
     */
    async function insertFoldChip({ shell, text, ref }) {
      holdFoldText(ref, text);
      let lastSpan = null;
      let lastLive = null;
      let lastReason = "no-span";
      let applied = false;
      let held = text;
      let placed = null;
      for (let attempt = 0; attempt < 8 && !applied; attempt += 1) {
        const live = shell.state !== undefined ? shell.state.getSnapshot() : undefined;
        if (live === undefined || typeof live.draftRev !== "number") {
          lastReason = "no-revision";
          break;
        }
        lastLive = live;
        // Recomputed every attempt: the editor's own commit may land between retries,
        // which bumps the revision and re-maps the caret.
        lastSpan = pastedRunSpan(shell, text, live.draftRev);
        if (lastSpan === null) {
          lastReason = "run-not-located";
          const waited = await settleTurn();
          if (!waited) break;
          continue;
        }
        // The chip must hold what the EDITOR holds, not what the clipboard carried:
        // the two differ whenever the editor normalized the paste (CRLF -> LF), and
        // holding the clipboard copy would make expand write text back that never
        // matched the run it replaced.
        if (lastSpan.text !== undefined && lastSpan.text !== text) {
          releaseFoldText(ref);
          holdFoldText(ref, lastSpan.text);
          held = lastSpan.text;
          placed = lastSpan.text === text ? null : { normalized: true };
        }
        const label = `已折叠 ${formatFoldSize(utf8Bytes(held))}`;
        const reference = {
          source: FOLD_SOURCE,
          ref,
          label,
          appearance: "file",
          clipboardText: label,
        };
        try {
          applied = shell.insertReference(reference, lastSpan) === true;
        } catch (error) {
          diag({ foldChipInserted: false, foldChipReason: String(error && error.message) });
          releaseFoldText(ref);
          return false;
        }
        if (!applied && attempt < 7) {
          const waited = await settleTurn();
          if (!waited) break;
        }
      }
      if (!applied) {
        releaseFoldText(ref);
        diag({
          foldChipInserted: false,
          foldChipReason: lastReason,
          foldRefuseSentRev: lastSpan === null ? undefined : lastSpan.draftRev,
          foldRefuseLiveRev: lastLive === null ? undefined : lastLive.draftRev,
          foldRefusePhase: lastLive === null ? undefined : lastLive.phase,
          foldRefuseSentEnd: lastSpan === null ? undefined : lastSpan.end,
          foldRefuseLiveDraftLen: lastLive === null || typeof lastLive.draft !== "string" ? undefined : lastLive.draft.length,
        });
        return false;
      }
      const label = `已折叠 ${formatFoldSize(utf8Bytes(held))}`;
      diag({
        foldChipInserted: true,
        foldChipHeldBytes: utf8Bytes(held),
        foldChipFootprint: label,
        foldChipNormalized: placed === null ? undefined : true,
        foldAfterInsertDraftShape: shell.state === undefined ? undefined : describeDraft(shell.state.getSnapshot().draft),
      });
      // BOTH facts are needed by the caller: the held text becomes the fold's own
      // text (what expand writes back), and the label is the chip's draft footprint
      // (what the draft shows in its place, and therefore the only sentinel that can
      // tell "this chip is still there" from "it left the editor").
      return { held, label };
    }

    /**
     * Tiny session-keyed store shared between the paste listener and the dock
     * card. Hand-rolled so the bundle depends on nothing but react.
     *
     * Shape matches dsh-client-store's snapshot store so the renderer can wrap it
     * directly in useSyncExternalStoreWithSelector.
     */
    function createSessionStore() {
      let state = {};
      const listeners = new Set();
      const publish = () => {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            /* a broken subscriber must not break the others */
          }
        }
      };
      return {
        getSnapshot() {
          return state;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set(sessionId, record) {
          state = { ...state, [sessionId]: record };
          publish();
        },
        clear(sessionId) {
          if (!(sessionId in state)) return;
          const next = { ...state };
          delete next[sessionId];
          state = next;
          publish();
        },
      };
    }

    /** Resolve the composer shell for one session, or null when it has no binding. */
    function shellOf(ctx, sessionId) {
      if (sessionId === undefined || sessionId === null) return null;
      try {
        return ctx.conversation.input.shell(sessionId) ?? null;
      } catch {
        return null;
      }
    }


    /**
     * Diff two consecutive drafts and return the pasted run, or null.
     *
     * Why a diff instead of a `paste` DOM listener: the editor is Lexical, whose
     * PASTE_COMMAND runs inside its own state machine and is neither reachable
     * from a document-level capture listener nor suppressible by
     * `preventDefault()` there. Focus-dependent event delivery also made the
     * listener miss pastes entirely (verified in-app: the listener was installed
     * and the draft changed, yet no paste event ever arrived). Watching the draft
     * store is focus-independent and cannot miss an insertion.
     *
     * The inserted run is located by trimming the common prefix and suffix of the
     * two drafts. A paste is a pure insertion, so that is exactly the new text.
     *
     * @returns the inserted substring, or null when nothing was inserted.
     */
    function insertedRun(previous, current) {
      if (typeof current !== "string" || current === "") return null;
      const before = typeof previous === "string" ? previous : "";
      if (before === current) return null;
      let head = 0;
      const maxHead = Math.min(before.length, current.length);
      while (head < maxHead && before[head] === current[head]) head += 1;
      let tail = 0;
      const maxTail = Math.min(before.length - head, current.length - head);
      while (tail < maxTail && before[before.length - 1 - tail] === current[current.length - 1 - tail]) tail += 1;
      const run = current.slice(head, current.length - tail);
      return run === "" ? null : run;
    }

    /**
     * Remove the pasted text from the resulting draft, leaving everything else.
     *
     * NOT simply `setDraft("")`: a paste can equally be an append after existing
     * text or a replacement of a selection, and clearing would silently discard
     * unrelated text in the append case. The occurrence removed is the one nearest
     * where the two drafts diverge, which is where the editor put the paste; that
     * resolves the replacement case correctly too, since there the pasted text is
     * what now sits at that boundary.
     *
     * A match that equals the whole draft is refused: that only happens when the
     * caller measured the draft itself rather than the pasted run, and honoring it
     * would delete unrelated text. Refusing degrades to "leave the text inline
     * next to the attachment", which is harmless, whereas deleting is not.
     *
     * @returns the draft with the paste taken out.
     */
    function removePastedText(current, candidate, previous) {
      if (typeof current !== "string") return "";
      if (typeof candidate !== "string" || candidate === "") return current;
      const before = typeof previous === "string" ? previous : "";
      // Refuse the append-under-a-whole-draft-measurement signature: the candidate
      // spans the entire draft while the pre-existing text is still its prefix,
      // which means the caller measured the draft instead of the pasted run and
      // honoring it would delete the user's own text. Note the two legitimate
      // whole-draft cases -- pasting into an empty draft, and replacing the whole
      // draft -- do not match this signature (no pre-existing prefix), so they
      // still clear correctly.
      if (candidate === current && before.length > 0 && current.startsWith(before)) return current;
      let diverge = 0;
      const max = Math.min(before.length, current.length);
      while (diverge < max && before[diverge] === current[diverge]) diverge += 1;
      let best = -1;
      let bestLength = 0;
      // Every rendering the editor is known to apply is tried, because the candidate is
      // usually the RAW clipboard payload (CRLF) while the editor holds its own rendering
      // (LF). Without this the run is "not found" for every Windows-authored paste.
      for (const variant of normalizations(candidate)) {
        for (let from = 0; ; ) {
          const at = current.indexOf(variant, from);
          if (at < 0) break;
          if (best < 0 || Math.abs(at - diverge) < Math.abs(best - diverge)) {
            best = at;
            bestLength = variant.length;
          }
          from = at + 1;
        }
      }
      // NOT LOCATED IS NOT "THE DRAFT IS EMPTY".
      //
      // The caller of this function is the post-spill cleanup, and its candidate may be
      // the raw clipboard payload. Returning "" here therefore meant setDraft("") -- the
      // user's pre-existing typed text was deleted along with the paste, while the
      // attachment (which holds the paste) looked like it had worked. Leaving `current`
      // untouched keeps the paste inline next to the attachment: recoverable, visible,
      // and nothing of the user's own text is lost.
      if (best < 0) return current;
      return current.slice(0, best) + current.slice(best + bestLength);
    }

    /**
     * A one-slot inbox for the text of the most recent paste.
     *
     * Why this exists in addition to the diff: a diff cannot recover the size of a
     * paste that REPLACES similar text. Verified in-app: pasting a JSON document
     * over an existing, structurally similar JSON document left only the differing
     * middle (8877 bytes) after prefix/suffix trimming, so a ~50,000-byte paste was
     * measured as 8877 and never reached the spill threshold. The amount of text
     * that arrived is simply not derivable from before/after drafts in that case.
     *
     * `beforeinput` with inputType `insertFromPaste` carries a DataTransfer holding
     * the real pasted text, and it fires before the insertion, so it is recorded
     * here and consumed by the next draft transition.
     */
    const PASTE_INPUT_TYPES = { insertFromPaste: true, insertFromPasteAsQuotation: true };

    /**
     * How long an armed paste stays eligible for the guaranteed retry.
     *
     * The draft watcher's window is a few seconds (an entry exists for the very next
     * revision). The ARMED path is different: stock refuses chip insertions while the
     * composer is `submitting`/`adjudicating`, and an approval prompt can sit open for
     * minutes, so the paste must stay re-foldable for as long as the text is still in
     * the editor. Five minutes is long enough for a human to answer a prompt and far
     * short enough that a forgotten entry cannot attach itself to unrelated typing.
     */
    const ARMED_PASTE_MS = 5 * 60 * 1000;
    /** The armed path's poll interval, and its give-up horizon (~5 minutes). */
    const ARMED_POLL_MS = 200;
    const ARMED_POLL_TRIES = Math.ceil(ARMED_PASTE_MS / ARMED_POLL_MS);

    function createPasteInbox() {
      /** Newest paste overall: the legacy no-argument view. */
      let pending = null;
      /** Newest paste whose DOM target could not name a session. */
      let unmapped = null;
      /** Last paste per session, so a session switch cannot steal another's paste. */
      const bySession = new Map();
      const keep = (entry) => {
        pending = entry;
        if (entry.sessionId === null) unmapped = entry;
        else {
          bySession.set(entry.sessionId, entry);
          // Bounded: one entry per session, and only the newest few sessions.
          if (bySession.size > 12) {
            const oldest = bySession.keys().next();
            if (oldest.done !== true) bySession.delete(oldest.value);
          }
        }
      };
      const isFresh = (entry, maxAgeMs) => entry !== null && Date.now() - entry.at <= maxAgeMs;
      const drop = (entry) => {
        if (pending === entry) pending = null;
        if (unmapped === entry) unmapped = null;
        if (entry.sessionId !== null && bySession.get(entry.sessionId) === entry) bySession.delete(entry.sessionId);
      };
      let seq = 0;
      return {
        record(text, source, sessionId) {
          if (typeof text !== "string" || text === "") return null;
          seq += 1;
          const entry = {
            // IDENTITY, not content. Two pastes of the SAME text are two pastes: every
            // "have I already handled this one" question must be answered per
            // insertion, never by comparing text (a text comparison silently swallows
            // the second copy of an identical 6 KB paste -- reported in the app as
            // "第一次有 chip，第二次没有").
            pasteId: seq,
            text,
            bytes: utf8Bytes(text),
            at: Date.now(),
            source,
            sessionId: sessionId === undefined || sessionId === null ? null : String(sessionId),
          };
          keep(entry);
          if (source !== undefined) diag({ lastPasteSource: source, lastPasteBytes: entry.bytes });
          // Visible evidence: an unmapped paste is not addressable by any session and can
          // therefore only be folded through the draft diff. If this ever appears in the
          // app, the composer's session stamp is missing and that is the thing to fix.
          if (entry.sessionId === null) diag({ pasteUnmapped: true, pasteUnmappedBytes: entry.bytes });
          return entry;
        },
        /**
         * Consume the pending paste for one session, or null when there is none.
         *
         * The age limit is what keeps a stale entry from being blamed for an
         * unrelated later edit: an entry is only ever meant for the very next
         * draft transition, which follows the insertion by a frame at most.
         *
         * A paste whose DOM target could not be mapped to a session carries no session
         * key, and such an entry is NOT addressable by any keyed lookup. Handing it to
         * whichever session asks first is worse than dropping it: the conversation that
         * really received the paste then finds nothing (so it silently never folds), and
         * the conversation that did NOT receive it gets that text attached to its own
         * draft -- possibly mailed as its message, and wiping a draft of its own on the
         * way. A keyed lookup therefore answers only from that session's own slot; the
         * legacy session-less view (`take()`/`peek()` with no argument) still sees it.
         */
        take(sessionId, maxAgeMs = 4000) {
          const key = sessionId === undefined || sessionId === null ? null : String(sessionId);
          if (key !== null) {
            const own = bySession.get(key);
            if (own === undefined) return null;
            drop(own);
            return isFresh(own, maxAgeMs) ? own : null;
          }
          const entry = pending;
          if (entry !== null) drop(entry);
          if (entry === null || !isFresh(entry, maxAgeMs)) return null;
          return entry;
        },
        /**
         * The pending paste for one session, WITHOUT consuming it.
         *
         * The armed path needs to look several times before it commits (the editor
         * inserts asynchronously). Consuming on a look would hand the recording to
         * the draft watcher's diff path instead, which cannot measure a paste that
         * replaced similar text — the very case the inbox exists for.
         */
        peek(sessionId, maxAgeMs = 4000) {
          const key = sessionId === undefined || sessionId === null ? null : String(sessionId);
          if (key !== null) {
            const own = bySession.get(key);
            if (own !== undefined && isFresh(own, maxAgeMs)) return own;
            if (own !== undefined) drop(own);
            // No cross-session fallback, ever -- see `take`.
            return null;
          }
          return pending !== null && isFresh(pending, maxAgeMs) ? pending : null;
        },
        /** Consume exactly this entry, and only while it is still the pending one. */
        consume(entry) {
          if (entry === null || entry === undefined) return false;
          const key = entry.sessionId === null ? null : String(entry.sessionId);
          const own = key === null ? unmapped : bySession.get(key);
          if (own !== entry && pending !== entry) return false;
          drop(entry);
          return true;
        },
      };
    }

    /**
     * Pick the text to measure for one transition.
     *
     * A recorded paste is authoritative: it is the actual text that arrived, so it
     * cannot be fooled by a replacement of similar text. The diff is only a
     * fallback for insertions we did not observe (typing, IME, drag-drop), where
     * prefix/suffix trimming is a sound way to isolate the new run.
     *
     * The diff has one documented blind spot beyond replacements: trimming can
     * consume up to `previous.length` at each end, so when the composer already
     * held a lot of text a genuinely huge insertion can still trim down to less
     * than the spill threshold (`run.length >= current.length - 2 * previous.length`).
     * That is caught here by measuring the whole draft whenever a single
     * transition grew it by at least a spill — no keystroke can insert 50,000
     * bytes at once, so such a jump is always a paste, and the whole draft is
     * certain to be present and at least that large.
     *
     * @returns the text to measure, or null when nothing was inserted.
     */
    function measurableText({ recorded, run, previous, current }) {
      if (recorded !== null && recorded !== undefined) return recorded.text;
      if (
        typeof current === "string" &&
        // Cheap pre-checks: every code unit encodes to at least one byte, so a
        // short string cannot reach the threshold, and an already-threshold-sized
        // diff needs no second opinion. Keeps the encoding work off the hot path.
        current.length >= SPILL_BYTES &&
        (run === null || run.length < SPILL_BYTES) &&
        typeof previous === "string"
      ) {
        if (utf8Bytes(current) - utf8Bytes(previous) >= SPILL_BYTES) return current;
      }
      return run;
    }

    /**
     * Retire the folds whose chip is no longer in the editor.
     *
     * A fold IS its chip: the chip node is the only carrier of that paste (the text is
     * in `foldTextByRef`, addressed by the chip's `ref`), so a fold is live exactly
     * while stock's projection still lists a chip with that ref. That is a stronger
     * test than looking for the chip's label text in the draft, which cannot tell two
     * same-sized pastes apart.
     *
     * A PENDING entry is exempt: its chip is not in the editor yet (the insertion is
     * deferred out of the editor update), which says nothing about whether it is live.
     *
     * @returns the surviving folds, for callers that need them.
     */
    /**
     * Put a fold's held text back over the label a re-created composer left behind.
     *
     * A chip can vanish from the editor without the plugin doing anything: leaving a
     * conversation and coming back gives a NEW shell, and stock seeds that editor from
     * the MIRRORED draft, in which a chip is only its `clipboardText` -- the label
     * ("已折叠 5.9 KB"), not the paste. The new editor therefore holds the label as
     * ordinary text with no chip node, so the fold's ref is genuinely gone.
     *
     * Evicting on that evidence is correct; RELEASING the held text there is data loss:
     * the box shows a size label and a send posts exactly that label. Restoring is a
     * span write (never `setDraft`, which would destroy other chips), so other folds and
     * the user's typing are untouched.
     *
     * @returns the written span, or false when there is no orphaned label to fill.
     */
    function restoreHeldTextOverLabel({ shell, entry, from = 0 }) {
      const held = foldTextByRef.get(entry.ref);
      if (typeof held !== "string" || held === "") return false;
      const label = (Array.isArray(entry.sentinels) ? entry.sentinels : []).find(
        (value) => typeof value === "string" && value !== "",
      );
      if (label === undefined) return false;
      const projection = shell === null || shell === undefined ? undefined : shell.projection;
      const detect = projection === null || projection === undefined ? undefined : projection.detectText;
      const rev = shell === null || shell === undefined || shell.state === undefined ? undefined : shell.state.getSnapshot()?.draftRev;
      if (typeof detect !== "string" || typeof rev !== "number") return false;
      const at = detect.indexOf(label, from);
      if (at < 0) return false;
      const target = { start: at, end: at + label.length, draftRev: rev };
      const actions = shell.actions;
      const write = actions !== undefined && typeof actions.insertText === "function"
        ? (value) => actions.insertText(value, target)
        : typeof shell.insertText === "function"
          ? (value) => shell.insertText(value, target)
          : null;
      if (write === null) return false;
      try {
        if (write(held) !== true) return false;
      } catch {
        return false;
      }
      diag({ foldRestoredOverLabel: true, foldRestoredBytes: utf8Bytes(held) });
      return { at, end: at + label.length };
    }

    function pruneFolds({ foldStore, sessionId, current, shell, onEvict }) {
      if (sessionId === undefined || sessionId === null) return [];
      const folds = foldEntries(foldStore.getSnapshot()[sessionId]);
      if (folds.length === 0) return [];
      const refs = liveFoldRefs(shell);
      const survives = (entry) => {
        if (entry.pending === true) return true;
        if (refs !== null) return refs.has(entry.ref);
        return foldTextPresent(entry, current);
      };
      const kept = folds.filter(survives);
      if (kept.length === folds.length) return kept;
      let cursor = 0;
      for (const entry of folds) {
        if (kept.includes(entry)) continue;
        // Restore before releasing: an involuntary eviction must not destroy the paste.
        // Labels are identical across folds, so the search continues past the one that
        // was just filled, keeping the folds in their draft order.
        const restored = restoreHeldTextOverLabel({ shell, entry, from: cursor });
        if (restored !== false) cursor = restored.end;
        releaseFoldText(entry.ref);
        if (typeof onEvict === "function") onEvict(entry);
      }
      if (kept.length === 0) foldStore.clear(sessionId);
      else foldStore.set(sessionId, foldRecord(kept));
      return kept;
    }

    /**
     * Decide what one draft transition means and perform it. This is the whole
     * detection layer, kept pure enough to test without a DOM.
     *
     * @returns "inline" | "fold" | "file".
     */
    function reactToDraft({ previous, current, run, recorded, removable, sessionId, conversation, shell, foldStore, index = 1, onUploadSettled, onRefused }) {
      // The watcher is the single authority for a fold's lifetime, and it is the only
      // place that sees every draft revision — so it gets to retire folds here, before
      // this transition is interpreted.
      //
      // There is deliberately NO "auto-expand on typing" any more. That rule existed
      // for the clamp-only design, where the folded text still sat in the editor and a
      // keystroke landed in an invisible box. With real chips the text is NOT in the
      // editor at all: typing lands after the chip and is plainly visible, so retiring
      // the fold there would only discard the chip (and its held text) for nothing.
      pruneFolds({ foldStore, sessionId, current, shell });

      const candidate = measurableText({ recorded, run, previous, current });
      const verdict = candidate === null ? { action: "inline", bytes: 0 } : decidePaste(candidate);
      diag({
        rtdVerdict: verdict.action,
        rtdBytes: candidate === null ? null : utf8Bytes(candidate),
        rtdRecorded: recorded === null || recorded === undefined ? null : recorded.bytes,
        rtdRun: run === null ? null : run.length,
        rtdCurrent: current.length,
      });
      if (sessionId !== undefined && sessionId !== null) {
        diagSession(sessionId, {
          verdict: verdict.action,
          verdictBytes: candidate === null ? null : utf8Bytes(candidate),
          verdictFrom: recorded === null || recorded === undefined ? "diff" : "paste",
          draftLen: current.length,
          phase: shell !== null && shell !== undefined && shell.state !== undefined ? shell.state.getSnapshot()?.phase : undefined,
        });
      }
      if (candidate === null) {
        return "inline";
      }
      if (verdict.action === "inline") return "inline";
      if (verdict.action === "fold") {
        if (sessionId === undefined) return "inline";
        // A fold IS a chip: with no shell that can host one there is nothing to fold
        // into, and the honest outcome is to leave the text inline rather than draw a
        // chip for text the user can still see.
        if (shell === undefined || shell === null || typeof shell.insertReference !== "function" || shell.state === undefined) {
          diag({ foldSkipped: "no-chip-host" });
          return "inline";
        }
        const excision =
          recorded !== null && recorded !== undefined && typeof recorded.text === "string" && recorded.text !== ""
            ? recorded.text
            : typeof removable === "string" && removable !== "" && removable !== current
              ? removable
              : current === candidate && previous !== ""
                ? (insertedRun(previous, current) ?? candidate)
                : candidate;
        const chipWanted = recorded !== null && recorded !== undefined && typeof recorded.text === "string" && recorded.text !== "" ? recorded.text : excision;
        // ONE PASTE, ONE CHIP — enforced by the mechanism, not by comparing text.
        //
        // The two triggers (the watcher and the armed retry) can both look at one
        // insertion, but only the FIRST of them finds the run in the editor: the winner
        // replaces that run with its chip, so the loser's `pastedRunSpan` no longer
        // matches anything and it stops. A text comparison here would instead swallow the
        // SECOND COPY of an identical paste -- which is exactly what the app reported:
        // "第一次粘贴 6K 有 chip，第二次粘贴同一段 6K 没有 chip，文本留在输入框".
        foldRefSeq += 1;
        const chipRef = `${sessionId}:${verdict.bytes}:${Date.now().toString(36)}:${foldRefSeq.toString(36)}`;
        // ONE PASTE = ONE ENTRY = ONE CHIP. The new entry is APPENDED, never substituted
        // for the previous fold: each chip is the only carrier of its own paste, so
        // overwriting a fold would delete that user's text.
        const entry = {
          ref: chipRef,
          // Identity of the insertion this fold came from, when it is known. It lets the
          // armed retry recognise "MY paste already has a chip" by id instead of polling
          // until the run disappears (and instead of comparing text, which swallowed a
          // second identical paste).
          pasteId: recorded === null || recorded === undefined ? undefined : recorded.pasteId,
          bytes: verdict.bytes,
          lines: countLines(candidate),
          text: chipWanted,
          // The draft still holds the raw run at this instant; the deferred insert
          // swaps it for the chip's footprint and rewrites the sentinel.
          sentinels: [current],
          pending: true,
          chipInserted: false,
        };
        foldStore.set(sessionId, foldRecord([...foldEntries(foldStore.getSnapshot()[sessionId]), entry]));
        // Defer the chip insertion out of the current editor update: stock publishes the
        // draft from inside the editor's own update, and inserting there hits Lexical
        // #337 ("no active editor") — the chip then fails silently.
        const settle = async () => {
          const pendingEntry = foldEntries(foldStore.getSnapshot()[sessionId]).find((fold) => fold.ref === chipRef);
          if (pendingEntry === undefined) {
            diag({ foldChipDeferred: "abandoned" });
            diagSession(sessionId, { chipDeferred: "abandoned" });
            // The fold was retired while this insertion was queued (a dismiss or an expand
            // raced the deferred insert). If the chip landed in the editor anyway it must
            // not stay there holding text the store has forgotten: it is invisible (the
            // rail has no entry for it) and cannot be dismissed. Remove it, and only then
            // release the hold -- a chip whose ref has no held text serializes its LABEL,
            // which is the data-loss shape this whole layer exists to prevent.
            if (writeOverChip({ shell, ref: chipRef, text: "", consumeSeparator: true })) {
              releaseFoldText(chipRef);
              diag({ foldChipRolledBack: true });
            }
            return;
          }
          let inserted = false;
          try {
            inserted = await insertFoldChip({ shell, text: chipWanted, ref: chipRef });
          } catch (error) {
            releaseFoldText(chipRef);
            diag({ foldChipDeferred: "threw", foldChipReason: String(error && error.message) });
            inserted = false;
          }
          const live = foldEntries(foldStore.getSnapshot()[sessionId]);
          const liveEntry = live.find((fold) => fold.ref === chipRef);
          if (inserted === false) {
            // ROLL BACK. No chip means the paste is still inline and visible in the
            // editor, so keeping the entry would draw a chip for content the user can
            // see twice. Removing it releases the by-ref hold with it.
            releaseFoldText(chipRef);
            if (liveEntry !== undefined) {
              const kept = live.filter((fold) => fold.ref !== chipRef);
              if (kept.length === 0) foldStore.clear(sessionId);
              else foldStore.set(sessionId, foldRecord(kept));
            }
            diag({ foldChipDeferred: "refused", foldRolledBack: liveEntry !== undefined });
            diagSession(sessionId, { chipDeferred: "refused", chipRolledBack: liveEntry !== undefined });
            // A REFUSAL IS NOT ALWAYS A DEAD END.
            //
            // Stock refuses `insertReference` while the composer is `submitting` or
            // `adjudicating` — i.e. while the previous message is in flight or waiting for
            // approval — and that state is per CONVERSATION. Rolling the fold back and
            // forgetting it is why a paste folds in an idle conversation and stays inline
            // in one that is busy: the text is still in the editor, so re-arming costs
            // nothing and the armed retry folds it as soon as the composer is editable
            // again. The retry never touches a composer whose phase still refuses.
            if (typeof onRefused === "function" && chipWanted !== "") onRefused(chipWanted);
            return;
          }
          if (liveEntry === undefined) {
            diag({ foldChipDeferred: "abandoned-after-retry" });
            return;
          }
          // `held` is what the editor really kept (the clipboard payload can be
          // normalized on the way in), `label` is the chip's footprint in the draft.
          const settled = { ...liveEntry, text: inserted.held, sentinels: [inserted.label], chipInserted: true, pending: false };
          foldStore.set(sessionId, foldRecord(live.map((fold) => (fold.ref === chipRef ? settled : fold))));
          diag({ foldChipDeferred: "inserted", foldChipFootprint: inserted.label, foldCount: live.length });
          diagSession(sessionId, { chipDeferred: "inserted", chipBytes: verdict.bytes, chipCount: live.length });
        };
        if (typeof queueMicrotask === "function") queueMicrotask(settle);
        else Promise.resolve().then(settle);
        diag({
          foldStoredBytes: verdict.bytes,
          foldStoredFromPaste: recorded !== null && recorded !== undefined,
          foldStoredDraftShape: describeDraft(current),
          foldCount: foldEntries(foldStore.getSnapshot()[sessionId]).length,
        });
        return "fold";
      }
      if (sessionId === undefined || conversation === undefined || conversation === null || shell === undefined || shell === null) {
        return "inline";
      }
      // Ownership is registered BEFORE the upload starts. `uploadPaste` settles from the
      // CURRENT upload snapshot, so an already-`ready` upload calls `onReady` inside this
      // call -- and registering afterwards then left the session marked "a spill is in
      // flight" forever, which muted the guaranteed retry for that conversation for the
      // rest of the session ("this conversation never folds again").
      spillInFlight.add(sessionId);
      let started;
      try {
        started = uploadPaste({
          conversation,
          sessionId,
          shell,
          text: candidate,
          index,
          onReady: () => {
            spillInFlight.delete(sessionId);
            if (onUploadSettled !== undefined) onUploadSettled(true);
          },
          onFailure: () => {
            spillInFlight.delete(sessionId);
            if (onUploadSettled !== undefined) onUploadSettled(false);
          },
        });
      } catch {
        spillInFlight.delete(sessionId);
        return "inline";
      }
      if (started === false) {
        // The composer refused the attachment (busy submit plane). The text stays
        // inline, so re-arm exactly as the fold path does: the attachment appears once
        // the composer accepts it.
        spillInFlight.delete(sessionId);
        if (typeof onRefused === "function" && candidate !== "") onRefused(candidate);
        return "inline";
      }
      if (recorded !== null && recorded !== undefined) markSpillAttempted(recorded.pasteId);
      return "file";
    }

    /** Monotonic tiebreaker so two folds in the same millisecond get distinct refs. */
    let foldRefSeq = 0;

    /** Identity for a re-armed retry that has no recording behind it. */
    let retryArmSeq = 0;

    /**
     * Spill bookkeeping, per session.
     *
     * A spill uploads the pasted text as a file while the text is STILL in the editor
     * (it is removed only once the upload reports `ready`), which makes that window
     * look exactly like "a big paste nobody folded yet". Without these two facts the
     * guaranteed retry would upload the same paste a second time and the composer would
     * gain a duplicate attachment. `spillInFlight` is the window; `spillAttempted`
     * remembers which text already had its attempt, so a failed upload is not retried
     * behind the user's back (the failed attachment card carries its own retry).
     */
    const spillInFlight = new Set();
    /**
     * Paste identities whose spill attempt has already run its course.
     *
     * Bounded: this is written once per spilled paste and only read while a retry is
     * armed, so keeping a short tail is enough and a long session cannot grow it without
     * limit.
     */
    const spillAttemptedPastes = [];
    const SPILL_ATTEMPTED_MAX = 64;
    const markSpillAttempted = (pasteId) => {
      if (pasteId === undefined) return;
      spillAttemptedPastes.push(pasteId);
      while (spillAttemptedPastes.length > SPILL_ATTEMPTED_MAX) spillAttemptedPastes.shift();
    };
    const spillAttempted = (pasteId) => spillAttemptedPastes.includes(pasteId);

    /**
     * Subscribe to one session's draft store and react to every transition.
     *
     * The spill layer's contract is "the text becomes a file". By the time we
     * observe the insertion Lexical has already put the text in the editor, so a
     * spill must take it back out again — but ONLY once the upload reports
     * `ready`. Removing it up front and restoring on error would lose the text
     * outright if the upload failed, so the editor keeps it for the brief
     * uploading window and a failure then needs no recovery at all.
     *
     * @returns an unsubscribe function.
     */
    function watchDraft({ shell, foldStore, sessionId, conversation, nextIndex, onRestore, onSendCommitted, onRefused, inbox }) {
      if (shell === undefined || shell === null || shell.state === undefined) {
        diag({ watchNoState: true });
        return () => {};
      }
      const store = shell.state;
      const initial = store.getSnapshot();
      let previous = typeof initial?.draft === "string" ? initial.draft : "";
      let lastRev = initial?.draftRev;
      // Set while we write to the draft ourselves, so our own publish does not
      // re-enter this subscriber as if the user had typed.
      let restoring = false;
      let tickCount = 0;
      return store.subscribe(() => {
        if (restoring) return;
        const snapshot = store.getSnapshot();
        if (snapshot === undefined || snapshot === null) return;
        const current = typeof snapshot.draft === "string" ? snapshot.draft : "";
        // Ground truth for "did the watcher ever see this edit": the app has no
        // console, so the first few transitions and every large one are recorded.
        tickCount += 1;
        if (tickCount <= 3 || current.length >= FOLD_BYTES) {
          diag({ tick: tickCount, tickLen: current.length, tickRev: snapshot.draftRev ?? null });
          diagSession(sessionId, { ticks: tickCount, lastTickLen: current.length });
        }
        const sameRev = snapshot.draftRev !== undefined && snapshot.draftRev === lastRev;
        // A COMPLETED SEND clears everything this plugin owns for the session.
        //
        // The send serializes every chip through our source and then stock clears the
        // draft, so the emptying arrives as an ordinary revision change: one
        // notification, one signal. Our bookkeeping must not survive it, or the next
        // paste in this session would inherit a fold for a chip that no longer exists.
        //
        // This still must run before the revision guard: stock's send publishes once
        // and the guard exists to suppress repeat work, not to filter the signal.
        if (typeof onSendCommitted === "function") {
          const folded = foldEntries(foldStore.getSnapshot()[sessionId]).length > 0;
          if (current === "" && folded) {
            onSendCommitted(sessionId);
            diag({ sendCommitted: true });
            previous = "";
            lastRev = snapshot.draftRev;
            return;
          }
        }
        if (sameRev) return;
        lastRev = snapshot.draftRev;
        const beforePaste = previous;
        const run = insertedRun(beforePaste, current);
        // The recording is claimed per SESSION. Two composers are alive whenever the
        // user switches conversations, so a session-blind lookup handed the paste of
        // the conversation just left to whichever composer published next — the paste
        // was "seen" by the wrong session and folded nowhere.
        const recorded = inbox.take(sessionId);
        const candidate = measurableText({ recorded, run, previous: beforePaste, current });
        // What may later be REMOVED from the draft is not the same thing as what
        // was MEASURED. The whole-draft backstop inside measurableText is a sound
        // size estimate but a terrible excision target: it equals `current`, so
        // removing it would delete the user's pre-existing text along with the
        // paste. Removal targets the recorded paste, or the located diff run,
        // both of which are genuine substrings of what is in the editor.
        const removable = recorded === null || recorded === undefined ? run : recorded.text;
        const decision = reactToDraft({
          previous: beforePaste,
          current,
          run,
          recorded,
          removable,
          sessionId,
          conversation,
          shell,
          foldStore,
          index: nextIndex(),
          onRefused,
          onUploadSettled: (ok) => {
            if (ok !== true) return;
            try {
              restoring = true;
              // Remove just the pasted run, IN PLACE. `setDraft` would rebuild the draft
              // as plain text and destroy any chip in it -- reported in-app as: paste 6 KB
              // (chip), paste 60 KB (spill), and the input box shows "已折叠 5.9 KB" with
              // the chip gone.
              const live = shell.state === undefined ? undefined : shell.state.getSnapshot();
              const outcome = removePastedRunInPlace({
                shell,
                text: removable,
                run,
                current: live === undefined ? current : live.draft,
                previous: beforePaste,
              });
              if (outcome === "skipped") {
                // Nothing was located, so there is nothing to take out: the text stays
                // inline beside its attachment and the draft is left ALONE.
                diag({ spillCleanupSkipped: true });
                diagSession(sessionId, { spillCleanupSkipped: true });
                return;
              }
              previous = shell.state === undefined ? current : shell.state.getSnapshot()?.draft ?? current;
              // Our own write publishes a new revision; absorb it so the next
              // callback does not mistake it for a user edit.
              lastRev = store.getSnapshot()?.draftRev;
              if (onRestore !== undefined) onRestore();
            } catch {
              /* the attachment chip is already in place, so a failed cleanup
                 only leaves the text inline as well, which is harmless */
            } finally {
              restoring = false;
            }
          },
        });
        previous = current;
        noteTransition(decision, candidate === null ? 0 : utf8Bytes(candidate));
      });
    }

    /** Synthesize the File a spill paste becomes. */
    function spillFile(text, index) {
      return new File([text], pasteFileName(text, index), { type: "text/plain" });
    }

    /**
     * Start an upload for one synthesized paste file and watch it settle.
     *
     * Failure handling is deliberately asymmetric: the text is still in the editor
     * throughout, so on `error` the synthesized chip is simply withdrawn and the
     * inline text remains as a complete fallback (nothing to restore). Only
     * `ready` reports success, which is what lets the caller remove the text.
     *
     * @returns true when the attachment was admitted, false when the composer
     *   refused it (busy submit plane), in which case the caller keeps the text
     *   inline.
     */
    function uploadPaste({ conversation, sessionId, shell, text, index, onReady, onFailure }) {
      const file = spillFile(text, index);
      diag({ uploadStartBytes: utf8Bytes(text), uploadFileName: file.name });
      let drafts;
      try {
        drafts = conversation.createDrafts(sessionId, [file]);
      } catch (error) {
        diag({ createDraftsThrew: String(error && error.message) });
        return false;
      }
      diag({ createDraftsCount: Array.isArray(drafts) ? drafts.length : -1 });
      if (shell.addAttachments(drafts.map((draft) => draft.id)) === false) {
        diag({ addAttachmentsRefused: true });
        conversation.releaseDraftAttachments(drafts);
        return false;
      }
      let settled = false;
      // Assigned after subscribe() returns; finish() may be reached from the
      // one-shot settleFrom() below, so it must tolerate stop being unset.
      let stop = () => {};
      const finish = (status, id) => {
        if (settled) return;
        settled = true;
        stop();
        if (status === "ready") {
          diag({ uploadReady: id });
          if (onReady !== undefined) onReady();
          return;
        }
        diag({ uploadFailed: id });
        // Why it failed matters more than that it failed: the entry carries the
        // reason, and without it a failed spill is indistinguishable from a spill
        // that never started.
        try {
          const entry = conversation.fileUploads.getSnapshot()?.[id];
          if (entry !== undefined) diag({ uploadFailureDetail: JSON.stringify(entry) });
        } catch {
          /* diagnostics only */
        }
        try {
          if (shell.removeAttachment(id) !== false) conversation.releaseDraftAttachment(id);
        } catch {
          /* the failed chip stays visible; the text is still inline too */
        }
        if (onFailure !== undefined) onFailure();
      };
      const settleFrom = (uploads) => {
        for (const draft of drafts) {
          const status = uploads[draft.id];
          if (status === undefined) continue;
          if (status.status === "ready" || status.status === "error") {
            finish(status.status, draft.id);
            return true;
          }
        }
        return false;
      };
      stop = conversation.fileUploads.subscribe(() => {
        if (!settled) settleFrom(conversation.fileUploads.getSnapshot());
      });
      // An upload can already have settled before this subscription existed (a
      // small file on a fast disk), and subscribing would then never fire again —
      // the text would stay inline forever. So check the current state once too.
      settleFrom(conversation.fileUploads.getSnapshot());
      return true;
    }

    /**
     * Read one session's slice out of a selector hook, tolerating an absent hook.
     *
     * A hook that is missing or not a function must NOT throw here: these
     * components render inside the composer, so an exception would take down the
     * user's ability to type at all — a far worse failure than a missing chip. A
     * missing expanded-store hook therefore degrades to "not expanded" (the folded
     * view, which is the safe state), and a missing fold hook to "no record" (the
     * composer renders untouched).
     */
    function readSessionSlice(hook, sessionId) {
      if (typeof hook !== "function") return undefined;
      const value = hook((state) => (state === undefined || state === null ? undefined : state[sessionId]));
      return value === null ? undefined : value;
    }

    /**
     * Chip rail for the fold layer, rendered INSIDE the composer card, in a band of
     * its own directly above the attachments row and the editor.
     *
     * It is the ONLY affordance for a 4000–50000 byte paste, and each chip has exactly
     * two outcomes:
     *
     *   - click the body  -> that paste's text is written back where its chip was, and
     *                        the chip unmounts (nothing is folded any more)
     *   - click the ×     -> THAT paste is DELETED: its chip node is removed from the
     *                        editor and its by-ref hold released
     *
     * One chip per paste, like stock's attachment rail. The chip's text is NOT in the
     * editor while folded: the editor holds one reference-chip node per fold, and the
     * text is held in `foldTextByRef`, addressed by the node's `ref`, which is what
     * stock serializes at submit.
     *
     * GEOMETRY: stock renders this slot inside `[data-composer-card]`'s overlay anchor,
     * which is `position:absolute; height:0` — the rail is therefore out of flow and
     * floats over the card's first rows, covering whatever the user types. The rail
     * measures ITSELF and publishes that height as `--dshps-chip-band` on the card
     * (plus the `data-dshps-chip` attribute), which the stylesheet turns into the
     * card's padding-top. Measuring beats a constant: the band wraps onto several rows
     * once there are several chips, and a hard-coded reserve would then be both wrong
     * and invisible.
     *
     * `usePasteFold` arrives as a SELECTOR hook bound by the renderer
     * (`observableHook` -> useSyncExternalStoreWithSelector), so it must be called with
     * a selector and it must be called on every render. It is the rail's only data
     * source: the watcher retires a fold once its chip leaves the editor, which is what
     * hides that chip.
     */
    function PasteFoldChip({ sessionId, usePasteFold, onToggle, onDismiss, onMount, t }) {
      const record = readSessionSlice(usePasteFold, sessionId);
      // THE AUTHORITATIVE WATCHER INSTALL POINT.
      //
      // This component only ever renders inside a mounted composer, for exactly the
      // session that composer belongs to, so its `sessionId` cannot be stale or
      // mismatched — unlike `sessions.list.current`, which is a *selection* and can
      // legitimately point at a session whose composer is not the one on screen.
      // Installing from here means "any composer we can draw a rail in gets a draft
      // watcher", which is the property the feature actually needs.
      React.useLayoutEffect(() => {
        diag({ railSession: sessionId === undefined ? "none" : String(sessionId) });
        if (typeof onMount === "function") onMount(sessionId);
      }, [sessionId, onMount]);
      const railRef = React.useRef(null);
      // STAMP THE COMPOSER CARD WITH THE SESSION IT BELONGS TO.
      //
      // The DOM is the only place that knows which conversation a paste belongs to:
      // a `paste`/`beforeinput` event carries no session id, and `sessions.list.current`
      // is a SELECTION, not the composer on screen. Without this stamp a paste is
      // recorded against no session, so any session's watcher may consume it while the
      // conversation that really received it never folds — the "chip in one
      // conversation, nothing in another" failure.
      React.useLayoutEffect(() => {
        const rail = railRef.current;
        if (rail === null || rail === undefined) return undefined;
        const card = typeof rail.closest === "function" ? rail.closest("[data-composer-card]") : null;
        if (card === null || card === undefined) return undefined;
        if (sessionId === undefined || sessionId === null) card.removeAttribute("data-dshps-session");
        else card.setAttribute("data-dshps-session", String(sessionId));
        return () => {
          card.removeAttribute("data-dshps-session");
        };
      }, [sessionId]);
      // ONE CHIP PER FOLD, like the image rail.
      const folds = foldEntries(record);
      const anyFold = folds.length > 0;
      const applyToggle = (foldRef) => {
        if (typeof onToggle === "function") onToggle(sessionId, true, foldRef);
      };
      const applyDismiss = (foldRef) => {
        if (typeof onDismiss === "function") onDismiss(sessionId, foldRef);
      };

      // Reserve the band the floating rail occupies, so it can never cover the
      // composer's own text. Runs on every fold-count change and follows the rail's
      // real height (several chips wrap onto more rows).
      React.useLayoutEffect(() => {
        if (!anyFold) return undefined;
        const rail = railRef.current;
        if (rail === null || rail === undefined) return undefined;
        const card = typeof rail.closest === "function" ? rail.closest("[data-composer-card]") : null;
        if (card === null || card === undefined) return undefined;
        const reserve = () => {
          const rect = typeof rail.getBoundingClientRect === "function" ? rail.getBoundingClientRect() : null;
          const height = rect !== null && rect !== undefined && typeof rect.height === "number" ? rect.height : 0;
          const band = Math.ceil(height) + CHIP_BAND_GAP;
          if (card.style !== undefined && typeof card.style.setProperty === "function") {
            card.style.setProperty("--dshps-chip-band", `${band}px`);
          }
          card.setAttribute("data-dshps-chip", "");
        };
        reserve();
        let observer = null;
        if (typeof ResizeObserver === "function") {
          observer = new ResizeObserver(reserve);
          observer.observe(rail);
        }
        return () => {
          if (observer !== null) observer.disconnect();
          if (card.style !== undefined && typeof card.style.removeProperty === "function") {
            card.style.removeProperty("--dshps-chip-band");
          }
          card.removeAttribute("data-dshps-chip");
        };
      }, [anyFold]);

      const label = t === undefined ? (key) => key : t;
      // The rail container renders even with no chips: its ref is what stamps the
      // composer card with the session id, and a composer with no chips yet is exactly
      // the composer about to receive its first paste. `data-empty` hides it so an
      // empty rail reserves no space.
      return React.createElement(
        "div",
        {
          className: "dshps-chip-rail",
          "data-paste-spill-rail": true,
          "data-empty": anyFold ? undefined : "",
          ref: railRef,
        },
        ...(anyFold
          ? folds.map((fold, index) => {
                const foldRef = fold.ref;
                const preview = foldPreviewOf(fold);
                return React.createElement(
                  "div",
                  {
                    key: foldRef,
                    className: "dshps-chip",
                    "data-paste-spill-chip": foldRef,
                    "data-paste-spill-chip-index": index,
                  },
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "dshps-chip-open",
                      "data-paste-spill-expand": foldRef,
                      // The chip is only mounted while ITS paste is folded, so the
                      // affordance is never in the expanded state.
                      "aria-expanded": false,
                      // "按原文发送" lives on the expand control's tooltip. A build that
                      // rendered it as a paragraph above the input box was rejected.
                      title: label("foldHint"),
                      onClick: (event) => {
                        if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
                        applyToggle(foldRef);
                      },
                    },
                    React.createElement(
                      "span",
                      { className: "dshps-chip-glyph", "aria-hidden": true },
                      React.createElement("svg", {
                        width: 12,
                        height: 12,
                        viewBox: "0 0 12 12",
                        fill: "none",
                        children: React.createElement("path", {
                          d: "M2 2h5l3 3v5H2z",
                          stroke: "currentColor",
                          strokeWidth: 1.2,
                          strokeLinejoin: "round",
                          strokeLinecap: "round",
                        }),
                      }),
                    ),
                    React.createElement(
                      "span",
                      { className: "dshps-chip-body" },
                      React.createElement(
                        "span",
                        { className: "dshps-chip-preview" },
                        // A record with no readable text (an older build, or a pure
                        // whitespace paste) still needs a label rather than an empty chip.
                        preview === "" ? label("foldTitle") : preview,
                      ),
                      React.createElement(
                        "span",
                        { className: "dshps-chip-action" },
                        label("foldExpandAction"),
                        React.createElement("span", { className: "dshps-chip-chevron", "aria-hidden": true }, "\u203A"),
                      ),
                    ),
                  ),
                  // "关闭即删除": discards THIS paste. Per-chip, because with several
                  // folds a session-level dismiss would delete all of them at once --
                  // the rail's x removes one item, so ours must too.
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "dshps-chip-dismiss",
                      "data-paste-spill-dismiss": foldRef,
                      "aria-label": label("foldDismissLabel"),
                      title: label("foldDismissLabel"),
                      onClick: (event) => {
                        if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
                        applyDismiss(foldRef);
                      },
                    },
                    "\u00D7",
                  ),
                );
              })
          : []),
      );
    }

    /**
     * @param ctx - client plugin context.
     */
    exports.apply = function apply(ctx) {
      diag({ build: BUILD_REV, applyRanAt: Date.now() });
      registerFoldSource(ctx);
      const foldStore = createSessionStore();
      /**
       * Expand ONE fold: put that paste's text back where its chip was.
       *
       * The write is an editor edit over the CHIP's own detect span, not a
       * `setDraft`. That distinction matters as soon as a second fold exists:
       * `setDraft` rebuilds the whole document from plain text, so it would destroy
       * every other chip (and those chips are the only carriers of their text).
       * Replacing just this one span leaves the rest of the composer -- other chips,
       * typed text, caret, undo history -- exactly as it was.
       *
       * Nothing is cleared unless the editor actually accepted the write, so a failed
       * expand leaves the chip on screen and the action retryable.
       */
      const toggleFold = (sessionId, next, foldRef) => {
        if (sessionId === undefined || sessionId === null) return;
        // There is no collapsed state to return to: the text is back in the editor and
        // the chip is gone, so "collapse" would have to re-fold a fresh run. Ignore it.
        if (next !== true) {
          diag({ foldToggleIgnored: true });
          return;
        }
        const record = foldStore.getSnapshot()[sessionId];
        const folds = foldEntries(record);
        const entry = foldRef === undefined
          ? folds[folds.length - 1]
          : folds.find((fold) => fold.ref === foldRef);
        if (entry === undefined) {
          diag({ foldExpandApplied: false, foldExpandReason: "no-fold" });
          return;
        }
        const shell = shellOf(ctx, sessionId);
        const applied = writeOverChip({ shell, ref: entry.ref, text: entry.text, consumeSeparator: true });
        diag({ foldExpandApplied: applied, foldExpandRef: entry.ref });
        if (!applied) return;
        releaseFoldText(entry.ref);
        // Expanding is an explicit "I want this text in the box": a retry that is still
        // armed for the same paste must not fold it back a moment later.
        stopArmedRetry(sessionId);
        const kept = folds.filter((fold) => fold.ref !== entry.ref);
        if (kept.length === 0) foldStore.clear(sessionId);
        else foldStore.set(sessionId, foldRecord(kept));
        diag({ manualExpand: "expanded", foldRemaining: kept.length });
      };
      /**
       * The chip's × handler: "关闭即删除" -- the × discards THAT paste for real.
       *
       * Deleting means deleting the chip node outright (the paste itself is out of the
       * editor, held by the chip), and releasing the by-ref hold so the text can never
       * be serialized again. Per-chip: with several folds a session-level wipe would
       * discard every paste at once, while the rail's × removes one item.
       */
      const dismissSessionFold = (sessionId, foldRef) => {
        if (sessionId === undefined || sessionId === null) return;
        const record = foldStore.getSnapshot()[sessionId];
        const folds = foldEntries(record);
        const entry = foldRef === undefined
          ? folds[folds.length - 1]
          : folds.find((fold) => fold.ref === foldRef);
        if (entry === undefined) {
          diag({ foldDismissed: "none", foldDismissReason: "no-fold" });
          return;
        }
        const shell = shellOf(ctx, sessionId);
        // "" over the chip's span removes the node; a failed write keeps the chip so the
        // × can be tried again instead of silently dropping the record.
        const applied = writeOverChip({ shell, ref: entry.ref, text: "", consumeSeparator: true });
        diag({ foldDismissApplied: applied, foldDismissRef: entry.ref });
        if (!applied) {
          diag({ foldDismissed: "none" });
          return;
        }
        releaseFoldText(entry.ref);
        // The user asked for this text to be plain: do not let the guaranteed retry
        // fold it again a moment later.
        stopArmedRetry(sessionId);
        const kept = folds.filter((fold) => fold.ref !== entry.ref);
        if (kept.length === 0) foldStore.clear(sessionId);
        else foldStore.set(sessionId, foldRecord(kept));
        diag({ foldDismissed: "dismissed", foldDismissedRef: entry.ref, foldRemaining: kept.length });
      };
      let counter = 0;
      const nextIndex = () => {
        counter += 1;
        return counter;
      };

      if (ctx.locale !== undefined) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-paste-spill: dictionaries");
      }

      // Detection watches the draft store rather than the `paste` DOM event.
      //
      // Verified in-app: a document-level capture listener WAS installed and the
      // draft DID change, yet no paste event ever reached the listener, so the
      // fold store stayed empty. The editor is Lexical, whose PASTE_COMMAND runs
      // in its own state machine; a capture listener neither reliably sees the
      // event (delivery follows focus) nor suppresses the insertion via
      // preventDefault(). Watching the draft is focus-independent and cannot miss
      // an insertion.
      //
      // `beforeinput` is observed ONLY to learn the pasted text itself, never to
      // gate or cancel anything: it fires before the insertion, so it is the one
      // place the real clipboard payload is available. The draft diff alone cannot
      // measure a paste that replaced similar text (verified in-app: a JSON
      // document pasted over a similar one looked like an 8877-byte insertion).
      const inbox = createPasteInbox();

      /**
       * The session whose composer this event happened in, read off the DOM.
       *
       * A paste event carries no session id, and `sessions.list.current` is a
       * SELECTION that can point at a conversation other than the one on screen. The
       * rail stamps `data-dshps-session` on its composer card, so the card above the
       * paste target is the one authoritative answer. `undefined` when the stamp is
       * missing (the rail is not mounted yet, or a paste outside any composer): the
       * recording then has no session key and stays a shared fallback.
       */
      const composerSessionOf = (event) => {
        try {
          const target = event.target;
          if (typeof Element === "undefined" || !(target instanceof Element)) return undefined;
          const card = typeof target.closest === "function" ? target.closest("[data-composer-card]") : null;
          if (card === null || card === undefined || typeof card.getAttribute !== "function") return undefined;
          const id = card.getAttribute("data-dshps-session");
          return id === null || id === "" ? undefined : id;
        } catch {
          return undefined;
        }
      };

      /**
       * One recorded paste: store it against its session, make sure that session has a
       * health-checked watcher, and ARM the guaranteed retry.
       */
      const accept = (text, source, sessionId) => {
        if (typeof text !== "string" || text === "") return;
        const entry = inbox.record(text, source, sessionId);
        if (utf8Bytes(text) < FOLD_BYTES) return;
        diagSession(sessionId, { pasteBytes: utf8Bytes(text), pasteSource: source });
        if (sessionId !== undefined) ensureWatcher(sessionId);
        armRetry(sessionId, text, entry === null ? undefined : entry.pasteId);
      };

      ctx.effect(() => {
        const inComposer = (event) => {
          if (typeof Element === "undefined") return false;
          const target = event.target;
          return target instanceof Element && target.closest(COMPOSER_SELECTOR) !== null;
        };
        // Both sources are observed because either alone can miss:
        //   * `beforeinput` fires before the insertion and also covers
        //     insertFromPaste's siblings, but its DataTransfer is not guaranteed
        //     to be populated for a paste in every engine.
        //   * `paste` carries clipboardData reliably, but was never observed to
        //     produce a usable measurement in-app.
        // Whichever arrives first wins; the inbox keeps only the newest.
        //
        // Delivery is recorded BEFORE any filtering, because "the event never
        // arrived" and "the event arrived but our guard rejected its target" look
        // identical in a diagnostic that is only written past the guard — and
        // telling those two apart is exactly what went wrong last time.
        const onBeforeInput = (event) => {
          try {
            if (event.inputType !== undefined && PASTE_INPUT_TYPES[event.inputType] === true) {
              diag({ lastBeforeInputPasteAt: Date.now() });
              if (!inComposer(event)) diag({ beforeInputPasteTargetRejected: true });
              else {
                const transfer = event.dataTransfer;
                if (transfer === null || transfer === undefined) diag({ beforeInputPasteNoData: true });
                else accept(transfer.getData("text/plain"), "beforeinput", composerSessionOf(event));
              }
            }
          } catch {
            /* observing must never disturb the editor */
          }
        };
        const onPaste = (event) => {
          try {
            diag({ lastPasteEventAt: Date.now() });
            const clipboard = event.clipboardData;
            if (!inComposer(event)) diag({ pasteTargetRejected: true });
            else if (clipboard === null || clipboard === undefined) diag({ pasteEventNoData: true });
            else {
              // A real file on the clipboard is stock's business, not ours.
              let hasFile = false;
              for (let i = 0; i < clipboard.items.length; i += 1) {
                if (clipboard.items[i].kind === "file") hasFile = true;
              }
              if (hasFile) diag({ pasteWasFile: true });
              else accept(clipboard.getData("text/plain"), "paste", composerSessionOf(event));
            }
          } catch {
            /* observing must never disturb the editor */
          }
        };
        document.addEventListener("beforeinput", onBeforeInput, { capture: true });
        document.addEventListener("paste", onPaste, { capture: true });
        return () => {
          document.removeEventListener("beforeinput", onBeforeInput, { capture: true });
          document.removeEventListener("paste", onPaste, { capture: true });
        };
      }, "dsh-paste-spill: paste text observer");

      // One watcher per session, created lazily and reused, so switching sessions
      // back and forth never re-baselines a draft mid-edit.
      //
      // Shells are materialized lazily (InputHub.shellFor), so `shell(id)` can
      // legitimately throw for a session whose scope has not mounted yet — and it
      // stays unresolved until the UI renders that session. Failing once and never
      // retrying would leave the feature silently dead for exactly those sessions,
      // so an unresolved session goes on a short bounded retry schedule.
      const watchers = new Map();
      /** How many live draft subscriptions one plugin instance may hold. */
      const WATCHER_MAX = 16;
      const pending = new Set();
      let retryFrame = null;

      /**
       * Keep the watcher registry bounded.
       *
       * `stopWatcher` otherwise runs only on a shell swap or plugin teardown, so a user who
       * visits many conversations leaves one live subscription (and its closures) behind
       * per session for the rest of the app's life. Map order is install order, so the
       * first other key is the most stale. Nothing is lost by dropping it: the next rail
       * mount or paste in that session installs a watcher again.
       */
      const dropStalestWatcher = (keepSessionId) => {
        for (const candidate of watchers.keys()) {
          if (candidate === keepSessionId) continue;
          stopWatcher(candidate);
          diagSession(candidate, { watcherDropped: true });
          return;
        }
      };

      const stopWatcher = (sessionId) => {
        const installed = watchers.get(sessionId);
        if (installed === undefined) return;
        watchers.delete(sessionId);
        try {
          installed.stop();
        } catch {
          /* teardown is best-effort */
        }
      };

      /**
       * Attach a watcher to the session's CURRENT shell, or report that it cannot.
       *
       * THE SHELL IS RE-RESOLVED ON EVERY CALL, and a changed shell replaces the
       * watcher. `InputHub.shellFor(binding)` caches one shell per session BINDING and
       * disposes it when the session scope unwinds (`shell.dispose()`,
       * `shells.delete(binding)`); a conversation that is left and reopened therefore
       * gets a NEW shell. A watcher cached against the old one subscribes to a store
       * nothing publishes to any more, so that conversation silently folds nothing —
       * forever, because `watchers.has(id)` used to short-circuit before any lookup.
       * That is the "chips work in one conversation but not in another" failure.
       */
      const tryInstall = (sessionId) => {
        const shell = shellOf(ctx, sessionId);
        if (shell === null) return false;
        const installed = watchers.get(sessionId);
        if (installed !== undefined && installed.shell === shell) return true;
        if (installed !== undefined) {
          stopWatcher(sessionId);
          bumpSession(sessionId, "shellSwaps");
          diagSession(sessionId, { shellSwapped: true });
        }
        // RECONCILE ON INSTALL. A conversation that is re-entered gets a new shell seeded
        // from the mirrored draft, and that seeding can land BEFORE this watcher
        // subscribes -- in which case no transition ever reports it, and a fold whose chip
        // is not in this editor would sit there with a dead ref until the next keystroke
        // (while the user looks at "已折叠 5.9 KB" and a send posts exactly that). Pruning
        // against the seeded draft now puts the held text back immediately.
        try {
          const seeded = shell.state === undefined ? undefined : shell.state.getSnapshot();
          if (seeded !== undefined && typeof seeded.draft === "string") {
            pruneFolds({ foldStore, sessionId, current: seeded.draft, shell });
          }
        } catch {
          /* reconciling must never break the install */
        }
        watchers.set(sessionId, {
          shell,
          stop: watchDraft({
            shell,
            foldStore,
            sessionId,
            conversation: ctx.conversation,
            nextIndex,
            inbox,
            onRestore: () => {
              diag({ spilledTextRemoved: true });
              diagSession(sessionId, { spillCleaned: true });
            },
            // A refusal is not final: re-arm so the guaranteed retry can fold this
            // paste once the composer stops being busy (see the armed retry below).
            onRefused: (text) => armRetry(sessionId, text),
            // A completed send retires everything this plugin owns for the session:
            // stock has already serialized every chip and cleared the draft, so the
            // holds must go too. Leaving one behind would let the NEXT paste inherit a
            // stale fold for a chip that no longer exists.
            onSendCommitted: () => {
              for (const fold of foldEntries(foldStore.getSnapshot()[sessionId])) releaseFoldText(fold.ref);
              foldStore.clear(sessionId);
              stopArmedRetry(sessionId);
              diagSession(sessionId, { sendCommitted: true });
            },
          }),
        });
        bumpSession(sessionId, "watchInstalls");
        if (watchers.size > WATCHER_MAX) dropStalestWatcher(sessionId);
        return true;
      };

      // ---------------------------------------------------------------------------
      // THE ARMED RETRY: one paste, one guaranteed attempt, whatever the state was.
      //
      // The draft watcher is the fast path, but every way it can lose a paste is
      // per-conversation: the shell behind it can be replaced (above), the revision
      // can land before it is subscribed, the caret-anchored run can need the editor's
      // own normalization, and stock REFUSES a chip insertion while the composer is
      // `submitting` or `adjudicating` — that is, while the previous message of THAT
      // conversation is still in flight or waiting for approval. Since the pasted text
      // is in the editor either way, the paste is re-attempted from the text itself
      // until it folds, so "which conversation" stops deciding whether a chip appears.
      // ---------------------------------------------------------------------------
      const armedRetries = new Map();

      const stopArmedRetry = (sessionId) => {
        const armed = armedRetries.get(sessionId);
        if (armed === undefined) return;
        armedRetries.delete(sessionId);
        if (armed.timer !== null && typeof clearTimeout === "function") clearTimeout(armed.timer);
      };

      /** Arm (or re-arm) the guaranteed retry for one session's paste. */
      const armRetry = (sessionId, text, pasteId) => {
        if (sessionId === undefined || sessionId === null || typeof text !== "string" || text === "") return null;
        if (utf8Bytes(text) < FOLD_BYTES) return null;
        stopArmedRetry(sessionId);
        retryArmSeq += 1;
        const armed = {
          text,
          // The identity of the insertion this retry is responsible for. A refusal
          // re-arm has no recording (the fast path never got one), so it mints its own:
          // it still has to be distinguishable from the NEXT paste.
          pasteId: pasteId === undefined ? `rearm-${retryArmSeq}` : pasteId,
          tries: 0,
          missing: 0,
          timer: null,
        };
        armedRetries.set(sessionId, armed);
        diagSession(sessionId, { armedBytes: utf8Bytes(text), armed: "waiting" });
        scheduleArmedRetry(sessionId);
        return armed;
      };

      function scheduleArmedRetry(sessionId) {
        const armed = armedRetries.get(sessionId);
        if (armed === undefined || typeof setTimeout !== "function") return;
        armed.timer = setTimeout(() => {
          armed.timer = null;
          // A timer callback runs outside any React/event boundary: an exception here
          // would be an unhandled rejection, so it is absorbed and reported instead.
          runArmedRetry(sessionId).catch(() => {
            armedRetries.delete(sessionId);
            diagSession(sessionId, { armed: "threw" });
          });
        }, ARMED_POLL_MS);
        // A polling timer must never hold a process open. In the browser the timeout id
        // is a number and this is skipped; under Node (the test suite) an un-unref'd
        // retry keeps the event loop alive for its whole five-minute horizon, so a test
        // that leaves a paste unhandled would hang the runner instead of failing.
        if (armed.timer !== null && typeof armed.timer.unref === "function") armed.timer.unref();
      }

      /** One armed attempt: fold this paste as soon as the composer will accept it. */
      async function runArmedRetry(sessionId) {
        const armed = armedRetries.get(sessionId);
        if (armed === undefined) return;
        armed.tries += 1;
        // The CLIPBOARD recording is a bonus here, never a requirement: it carries the
        // text as the clipboard had it (un-normalized by the editor), while the armed
        // entry itself already holds the text the paste inserted. A paste this plugin
        // never observed (the DOM event was missed, or the paste arrived before the
        // observer was installed) must still fold — that is the whole point of arming
        // from the refusal. A NEWER paste supersedes the armed one.
        const recording = inbox.peek(sessionId, ARMED_PASTE_MS);
        if (recording !== null && recording.pasteId !== armed.pasteId) {
          // A NEWER paste takes over this session's retry slot. (Identity, never text:
          // an identical second paste has its own pasteId and must not be mistaken for
          // the one already handled.)
          armedRetries.delete(sessionId);
          diagSession(sessionId, { armed: "superseded" });
          return;
        }
        const giveUp = () => {
          armedRetries.delete(sessionId);
          diagSession(sessionId, { armed: "gave-up", armedTries: armed.tries });
        };
        if (armed.tries > ARMED_POLL_TRIES) {
          giveUp();
          return;
        }
        // Once a paste has a chip, its run is GONE from the editor, so the retry ends by
        // itself through `pastedRunSpan` below -- it must NOT end by comparing text: an
        // identical second paste is a different paste and needs its own chip. (That
        // comparison was a real regression: "第一次有 chip，第二次粘贴同一段文本没有 chip".)
        //
        // AN UPLOAD ALREADY OWNS THIS PASTE. A spill keeps the text in the editor until
        // the upload reports ready, so without this the retry would treat that window as
        // an unfolded paste and attach a SECOND copy of the same file.
        if (spillInFlight.has(sessionId)) {
          diagSession(sessionId, { armed: "waiting-spill", armedTries: armed.tries });
          scheduleArmedRetry(sessionId);
          return;
        }
        // Already folded: the fast path won. Checked BY IDENTITY, so a second paste of the
        // same text (a different pasteId) is never mistaken for this one.
        const armedFold = foldEntries(foldStore.getSnapshot()[sessionId]).find(
          (fold) => fold.pasteId === armed.pasteId && (fold.pending === true || fold.chipInserted === true),
        );
        if (armedFold !== undefined) {
          armedRetries.delete(sessionId);
          diagSession(sessionId, { armed: "already-folded" });
          return;
        }
        if (spillAttempted(armed.pasteId)) {
          // THIS paste's spill attempt finished (ready or failed). A failed one leaves the
          // text inline with its own retry affordance on the attachment card;
          // re-uploading it automatically is not this layer's call.
          armedRetries.delete(sessionId);
          diagSession(sessionId, { armed: "spill-settled" });
          return;
        }
        const shell = shellOf(ctx, sessionId);
        const snapshot = shell === null || shell.state === undefined ? undefined : shell.state.getSnapshot();
        if (snapshot === undefined || typeof snapshot.draft !== "string") {
          scheduleArmedRetry(sessionId);
          return;
        }
        const span = pastedRunSpan(shell, armed.text, snapshot.draftRev);
        if (span === null) {
          const busyPhase = snapshot.phase;
          if (busyPhase !== undefined && busyPhase !== "plain" && busyPhase !== "claimed") {
            // A busy composer is not evidence about the run: wait without spending the
            // locate budget, or an approval prompt could time the fold out.
            diagSession(sessionId, { armed: "waiting-phase", armedPhase: busyPhase, armedTries: armed.tries });
            scheduleArmedRetry(sessionId);
            return;
          }
          // The text is no longer in the editor at all (already folded, or deleted), so
          // there is nothing left to fold. Consecutive misses, not a cumulative count: a
          // single unlocatable poll must not shorten the horizon for a paste that is
          // still there.
          armed.missing += 1;
          diagSession(sessionId, { armed: "run-not-located", armedMissing: armed.missing, armedTries: armed.tries });
          if (armed.missing >= 30) {
            giveUp();
            return;
          }
          scheduleArmedRetry(sessionId);
          return;
        }
        armed.missing = 0;
        const phase = snapshot.phase;
        if (phase !== undefined && phase !== "plain" && phase !== "claimed") {
          // Stock will refuse the insertion right now (submitting / adjudicating). Keep
          // the text inline and stay armed; the chip appears when the composer is free.
          diagSession(sessionId, { armed: "waiting-phase", armedPhase: phase, armedTries: armed.tries });
          scheduleArmedRetry(sessionId);
          return;
        }
        if (recording !== null && !inbox.consume(recording)) {
          armedRetries.delete(sessionId);
          return;
        }
        armedRetries.delete(sessionId);
        const previous = removePastedText(snapshot.draft, span.text, "");
        diagSession(sessionId, { armed: "folding", armedTries: armed.tries });
        const armedOutcome = reactToDraft({
          previous,
          current: snapshot.draft,
          run: span.text,
          recorded: recording,
          removable: span.text,
          sessionId,
          conversation: ctx.conversation,
          shell,
          foldStore,
          index: nextIndex(),
          onRefused: (text) => armRetry(sessionId, text),
          onUploadSettled: (ok) => {
            if (ok !== true) return;
            try {
              const live = shell.state === undefined ? undefined : shell.state.getSnapshot();
              // In place, for the same reason as the watcher's cleanup: this paste may
              // have landed in a composer that already holds a folded chip.
              const outcome = removePastedRunInPlace({
                shell,
                text: span.text,
                run: span.text,
                current: live === undefined ? previous : live.draft,
                previous,
              });
              diagSession(sessionId, { spillCleaned: outcome !== "skipped", spillCleanup: outcome });
            } catch {
              /* the attachment is already in place; a failed cleanup is harmless */
            }
          },
        });
        if (armedOutcome === "file") markSpillAttempted(armed.pasteId);
      }

      // Retries NEVER expire. A shell can become resolvable long after this plugin
      // applies — the session list arrives from the host asynchronously, and a session
      // that is not the current selection materializes only when its composer mounts.
      // The old bounded (~2s) window silently left the feature dead for those
      // sessions, with no error anywhere: paste in, nothing happens, forever. A tick
      // is one WeakMap lookup, so retrying indefinitely is free; after the first ~2s
      // it drops to ~3 checks/s instead of one per frame.
      const scheduleRetry = () => {
        if (typeof requestAnimationFrame !== "function") return;
        if (retryFrame !== null) return;
        let ticks = 0;
        const tick = () => {
          retryFrame = null;
          ticks += 1;
          if (ticks <= 120 || ticks % 20 === 0) {
            for (const id of [...pending]) {
              if (tryInstall(id)) pending.delete(id);
            }
          }
          if (pending.size > 0) retryFrame = requestAnimationFrame(tick);
        };
        retryFrame = requestAnimationFrame(tick);
      };

      const ensureWatcher = (sessionId) => {
        if (sessionId === undefined || sessionId === null) {
          diag({ watchAsk: "none" });
          return;
        }
        diag({ watchAsk: String(sessionId) });
        if (tryInstall(sessionId)) {
          diag({ watchOk: String(sessionId) });
          pending.delete(sessionId);
          return;
        }
        // Tell the two very different failures apart: "no binding for this id" (the
        // shell service throws) versus "binding exists but the shell is unavailable".
        let lookup = "ok";
        try {
          ctx.conversation.input.shell(sessionId);
        } catch (error) {
          lookup = String((error && error.message) || error);
        }
        diag({ watchNoShell: String(sessionId), watchShellLookup: lookup });
        diagSession(sessionId, { watch: "no-shell" });
        pending.add(sessionId);
        scheduleRetry();
      };

      ctx.effect(() => {
        let current = ctx.sessions.list.getSnapshot().current;
        ensureWatcher(current);
        const dispose = ctx.sessions.list.subscribe(() => {
          const next = ctx.sessions.list.getSnapshot().current;
          if (next === current) return;
          current = next;
          ensureWatcher(next);
        });
        return () => {
          dispose();
          if (retryFrame !== null && typeof cancelAnimationFrame === "function") {
            cancelAnimationFrame(retryFrame);
            retryFrame = null;
          }
          pending.clear();
          // Module-scope spill bookkeeping must not outlive the plugin: a session left
          // marked "a spill is in flight" mutes its retry for a later install.
          spillInFlight.clear();
          for (const sessionId of [...armedRetries.keys()]) stopArmedRetry(sessionId);
          for (const sessionId of [...watchers.keys()]) stopWatcher(sessionId);
        };
      }, "dsh-paste-spill: draft watcher");

      ctx.effect(() => {
        const selector = 'style[data-plugin-css="dsh-paste-spill"]';
        // Replace rather than skip-if-present. A hot reload can re-apply this
        // plugin while the previous build's stylesheet is still in the head, and
        // returning early there would leave geometry from the OLD build in force
        // for the new one — which is a silent, very confusing failure when the
        // slot itself just changed.
        for (const stale of document.querySelectorAll(selector)) stale.remove();
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-paste-spill";
        tag.dataset.pluginCss = "dsh-paste-spill";
        tag.textContent =
          // Hide stock's inline chip rendering so the user sees only our rail.
          //
          // The selector keys on `data-composer-chip`, the attribute stock's
          // ReferenceChipNode stamps on the node element with the reference's SOURCE
          // name -- stable across app builds. The previous build keyed on a
          // CSS-module class hash (".QiNVUW_chip") that does not exist in this app at
          // all, so the native chip was never hidden: it sat in the editor under the
          // rail, and typing ran into it.
          //
          // The chip node + its trailing space stay in the editor: the node carries
          // the reference stock serializes at submit, and the space is where the caret
          // lands so the composer stays typeable.
          `[data-composer-card] [data-composer-chip="${FOLD_SOURCE}"]{display:none}` +
          // The rail container is always mounted (its ref stamps the composer card with
          // the session id); with no chips it must reserve nothing at all.
          ".dshps-chip-rail[data-empty]{display:none}" +
          ".dshps-chip-rail{" +
          "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;" +
          "padding:4px 12px 0 12px}" +
          ".dshps-chip{" +
          "width:fit-content;max-width:calc(100% - 24px);" +
          // A COMPACT SINGLE ROW. The old 40px two-line chip made the band tall enough
          // to sit over the editor's first line; a 28px row keeps the reserved band
          // small. The height is also measured at runtime, so nothing depends on this
          // number being exact.
          "height:28px;box-sizing:border-box;" +
          "border:.5px solid var(--dsw-alias-border-l2,#0000001f);" +
          "background:var(--dsw-specific-input-major,transparent);" +
          "border-radius:8px;align-items:center;display:flex;" +
          "text-align:left;font:inherit;color:inherit;overflow:hidden}" +
          ".dshps-chip:hover{border-color:var(--dsw-alias-border-l1,#00000033)}" +
          ".dshps-chip-open{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px;" +
          "height:100%;padding:0 4px 0 6px;border:none;background:transparent;font:inherit;" +
          "color:inherit;cursor:pointer;text-align:left}" +
          ".dshps-chip-open:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-2px;border-radius:8px}" +
          ".dshps-chip-glyph{flex:none;display:inline-flex;align-items:center;justify-content:center;" +
          "width:18px;height:18px;border-radius:5px;background:var(--dsw-alias-bg-base,#0000000a);" +
          "color:var(--dsw-alias-label-secondary)}" +
          ".dshps-chip-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:row;" +
          "align-items:center;gap:6px}" +
          ".dshps-chip-preview{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;" +
          "white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px}" +
          ".dshps-chip-action{display:flex;align-items:center;gap:2px;flex:none;" +
          "color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:14px;white-space:nowrap}" +
          ".dshps-chip-chevron{flex:none;font-size:10px}" +
          ".dshps-chip-dismiss{flex:none;display:inline-flex;align-items:center;justify-content:center;" +
          "width:18px;height:18px;margin-right:5px;padding:0;border:none;border-radius:999px;" +
          "background:var(--dsw-alias-label-primary,#000);color:var(--dsw-alias-bg-base,#fff);" +
          "font-size:12px;line-height:1;cursor:pointer;opacity:.85}" +
          ".dshps-chip-dismiss:hover{opacity:1}" +
          ".dshps-chip-dismiss:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}" +
          // The card reserves a band for the floating rail. The rail measures itself
          // and writes --dshps-chip-band, so this is correct for zero, one, or a
          // wrapping row of chips -- and, unlike the old hard-coded 60px, it cannot
          // disagree with the rail the user is looking at.
          "[data-composer-card][data-dshps-chip]{" +
          "padding-top:calc(8px + var(--dshps-chip-band,0px))}"
        document.head.appendChild(tag);
        return () => tag.remove();
      }, "dsh-paste-spill: styles");

      // The ONLY registration. `conversation.input.overlay` is rendered INSIDE
      // `[data-composer-card]`, above the editor, scoped to one session — exactly
      // what "fold the input box, with nothing outside it" needs.
      //
      // The previous build ALSO registered `conversation.input.dock` for a separate
      // hint card. That slot renders as a sibling ABOVE the whole card (next to the
      // stock todo/queue docks), so the hint could only ever be outside the input
      // box, and it was removed for that reason.
      //
      // Chosen after checking the alternatives: `input.attachments` is kind
      // "single" and already owned by dsh-client-ui-attachment, and the renderer
      // renders only `entriesOfSlot(...)[0]`, so a second registrant would be
      // silently dropped (or, worse, displace the stock attachment UI); the
      // in-card `accessory` row is a prop of InputBar, not fed by any slot; and the
      // editor is private to SessionInputShell, so a real in-editor chip would mean
      // hand-editing another package's Lexical instance and rebuilding the
      // submitted text (which is what breaks slash/goal parsing). A list-kind,
      // session-scoped slot needs neither.
      ctx.slots.inject("conversation.input.overlay", () =>
        ctx.slots.register(
          {
            name: "conversation.input.overlay",
            id: "paste-spill",
            order: 0,
            locale: NS,
            inject: (sessionId) => ({
              sessionId,
              // A store, NOT a plain function: the renderer wraps every hook source
              // in observableHook -> useSyncExternalStoreWithSelector. The fold store
              // is the rail's ONLY source. It deliberately does not also read the
              // session's draft: that hook is materialized once per session binding
              // and cached, so a binding created before the shell existed would hold
              // a permanently absent store and hide the chips even with a valid
              // record. The draft watcher, which demonstrably sees every revision,
              // retires folds instead.
              hooks: { pasteFold: foldStore },
              // Both handlers are plain functions, not stores: the rail does not need
              // to re-render on a hold change, it re-renders on the fold store. Each
              // carries the CHIP's ref, so expand and × act on that one paste.
              onToggle: toggleFold,
              onDismiss: dismissSessionFold,
              // Lets the rail itself install the watcher for the composer it renders
              // in (see PasteFoldChip): the rail's sessionId is the mounted composer's.
              onMount: ensureWatcher,
            }),
          },
          PasteFoldChip,
        ),
      );
    };
    // `inputTriggers` was in this list for a design that no longer exists: the chip was
    // once a real editor node contributing a lone U+FFFC placeholder to the draft, which
    // needed the trigger roster to register a chip source. Nothing registers a source
    // any more -- the fold is pure CSS over text that never leaves the draft -- but the
    // key is harmless and its removal would be an untested change to the inject contract.
    exports.inject = ["slots", "conversation", "sessions", "locale", "inputTriggers"];
    exports.__internals = {
      FOLD_BYTES,
      SPILL_BYTES,
      PREVIEW_CHARS,
      PASTE_NAME_PREFIX,
      FOLD_SOURCE,
      CHIP_BAND_GAP,
      formatFoldSize,
      utf8Bytes,
      decidePaste,
      countLines,
      pasteFileName,
      foldTextPresent,
      foldEntries,
      foldRecord,
      liveFoldRefs,
      detectSpanOfRef,
      pastedRunSpan,
      writeOverChip,
      pruneFolds,
      describeDraft,
      foldPreview,
      foldPreviewOf,
      readSessionSlice,
      createSessionStore,
      insertedRun,
      measurableText,
      removePastedText,
      createPasteInbox,
      spillFile,
      uploadPaste,
      reactToDraft,
      watchDraft,
      PasteFoldChip,
      holdFoldText,
      releaseFoldText,
      insertFoldChip,
      registerFoldSource,
      __foldTextByRef: foldTextByRef,
      // Module-scope spill ownership. Exposed so the suite can assert that a finished
      // upload does not leave a session permanently "owned by a spill" -- a state that
      // mutes the guaranteed retry for that conversation with no visible error.
      __spillInFlight: spillInFlight,
    };
    return module.exports;
  },
});
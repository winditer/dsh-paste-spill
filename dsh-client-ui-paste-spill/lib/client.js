// dsh-client-ui-paste-spill — web client half.
//
// Inbound large-paste handling for the composer:
//   * >= 50000 UTF-8 bytes -> synthesize a File and ride the existing attachment
//     upload path, so the message carries a legal `file` block and dsh-llm hands
//     the model a read-only host path with no format change anywhere.
//   * >= 4000 bytes -> leave the text in the editor untouched and show a fold
//     card in the composer dock.
//
// Module format: window.__ModuleLoader__ factory bundle (see
// @deepseek-ai/dsh-client-modules). Pure JS plus require("react"), ships as-is.

window.__ModuleLoader__.load({
  id: "dsh-client-ui-paste-spill",
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
    /** Bumped by hand so the boot marker identifies the exact build in the GUI. */
    const BUILD_REV = "fold-css-1";
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
     * Decide whether a fold record still applies to a draft, given that the draft
     * may be unreadable.
     *
     * The card must survive an unreadable draft: the dock's `draft` hook is bound
     * once per session binding and cached, so if the session's shell had not been
     * materialized yet it holds a permanently absent store. Treating that as "the
     * text is gone" would hide the card forever, which is exactly the failure this
     * replaces. The watcher, which does see every draft change, is responsible for
     * clearing the record when the text actually leaves, so absence of evidence is
     * not evidence of absence here.
     */
    function foldApplies(record) {
      return record !== undefined && record !== null;
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
     * Which text an EXPAND must write back into the composer, if any.
     *
     * Two sources, in order:
     *
     *  1. `held` -- the by-ref hold. Present only while the chip's text is genuinely
     *     out of the editor, which is the case a real chip fold creates.
     *  2. `record.text` -- the record's own copy.
     *
     * The fallback matters: the by-ref hold is released by several paths (a refused
     * insert, an earlier expand), so it is not a reliable source here. When the draft
     * is only the chip's placeholder and nothing is restored, the chip disappears and
     * the composer stays EMPTY -- the user's text appears to have been deleted. That is
     * the reported "点击在文本框中显示后，输入框中没有出现任何文本".
     *
     * Returns undefined for a clamp-only fold: the text never left the editor, so
     * expanding is purely visual. Writing it back there would re-create the editor
     * contents and drop the caret and undo history for no reason.
     *
     * @returns the text to write, or undefined to write nothing.
     */
    function restoreTextFor({ held, record }) {
      if (typeof held === "string" && held !== "") return held;
      if (record === undefined || record === null) return undefined;
      // Only a chip fold needs a restore: for a clamp-only fold the text is still in
      // the editor and the draft is that text, not the placeholder.
      if (record.chipInserted !== true) return undefined;
      return typeof record.text === "string" && record.text !== "" ? record.text : undefined;
    }

    /**
     * Is a hold active for this session?
     *
     * A held fold is the collapsed state after the collapse became a real edit: the
     * text is out of the draft and in the hold store. The chip must stay visible
     * then, which is why visibility is `foldApplies(record) || holdApplies(...)`
     * rather than the record alone — the record is precisely what the watcher
     * retires once the text leaves the draft, and a collapse guarantees it leaves.
     */
    function holdApplies(holdStore, sessionId) {
      if (holdStore === undefined || holdStore === null) return false;
      if (typeof holdStore.has !== "function") return false;
      return holdStore.has(sessionId) === true;
    }

    /**
     * Max characters of pasted content shown on the chip's preview line.
     *
     * 20 by request: the chip is two lines (this preview, then the expand action),
     * and a short preview is enough to recognise the paste without the line turning
     * into a wall of text. Raised from 40 for the same reason.
     */
    const PREVIEW_CHARS = 20;

    /**
     * Session-keyed container for the text a collapse took out of the editor.
     *
     * This is the guard the watcher reads as "the text is intentionally out of the
     * draft". It MUST be set whenever the text leaves the composer, which for the
     * chip design is the moment the chip is inserted: the chip replaces the draft
     * with a lone U+FFFC, and the watcher's staleness test (`foldTextPresent`) is
     * false for a draft that no longer contains the record's sentinel. Without a
     * live hold the watcher therefore retires the record in that gap, and the chip's
     * visible affordance never renders (verified in-app: stock's native chip node
     * appeared while our preview/action/x did not).
     *
     * Separate from the record on purpose: the record is retired precisely when text
     * leaves the draft, so the held text cannot ride on it.
     */
    function createHoldStore() {
      const held = new Map();
      return {
        get(sessionId) {
          if (sessionId === undefined || sessionId === null) return undefined;
          const entry = held.get(sessionId);
          return entry === undefined ? undefined : entry.text;
        },
        has(sessionId) {
          return sessionId !== undefined && sessionId !== null && held.has(sessionId);
        },
        set(sessionId, text) {
          if (sessionId === undefined || sessionId === null) return;
          held.set(sessionId, { text });
        },
        clear(sessionId) {
          held.delete(sessionId);
        },
        /** Iterable of `[sessionId, text]`, for teardown and diagnostics. */
        entries() {
          return [...held.entries()].map(([id, entry]) => [id, entry.text]);
        },
      };
    }

    /**
     * Dismiss a fold: "关闭即删除" -- the chip's x discards the paste for real.
     *
     * Deleting means deleting the TEXT. Under display-only folding the collapsed
     * text still sits in the composer, so removing just the chip would leave exactly
     * what the user asked to discard. The text is cut out of the draft and the fold
     * state is retired last, so a failed write leaves the chip on screen (retryable)
     * rather than vanishing while the text survives.
     *
     * @returns "dismissed" when something was discarded, "none" otherwise.
     */
    function dismissFold({ sessionId, holdStore, readDraft, removeText, writeDraft, clearFold, releaseChip }) {
      const record = holdStore.has(sessionId);
      const current = typeof readDraft === "function" ? readDraft() : "";
      const next = typeof removeText === "function" ? removeText(current) : current;
      const changed = next !== current;
      // Release the chip's hold BEFORE returning, so the ref cannot outlive the chip.
      // A hold that survives × would let a later send resolve text the user thought
      // they had deleted; releasing it makes that serialize fail loudly instead.
      if (typeof releaseChip === "function") releaseChip();
      if (!record && !changed) return "none";
      if (changed && writeDraft(next) === false) return "none";
      holdStore.clear(sessionId);
      if (typeof clearFold === "function") clearFold();
      return "dismissed";
    }

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
     * DOM attribute carrying the collapsed state on the composer card. The card
     * (not our own subtree) is the only element that can clamp the editor, because
     * the scroll container we need to shrink is a stock sibling we must not wrap
     * or restyle selectively by hand.
     */
    const FOLD_ATTR = "data-dshps-folded";

    /**
     * Height of the faded band at the bottom of a collapsed editor, in px. Must
     * match the mask gradient stop in the stylesheet. Only the band is a toggle
     * target: the visible lines above it keep normal caret behaviour, so a user can
     * paste a huge document, collapse, and still click in to append "summarize
     * this" without the composer springing open.
     */
    const FADE_PX = 30;

    /**
     * Clamped height of the editor while folded, in px — about TWO lines plus the
     * container's own top padding. The user asked for two visible lines: enough to
     * recognise the paste, short enough that the fold clearly reads as folded.
     *
     * Derived from the previous value rather than guessed: 84px was empirically
     * ~3 lines including padding, and every plausible padding (8-16px) puts the
     * per-line height at 23-25px, so 2 lines lands at 59-61px. 60 is the middle
     * and is what the app was verified against.
     */
    const FOLD_CLAMP_PX = 60;

    /** The stock scroll container that the collapsed style clamps. */
    const SCROLL_SELECTOR = "[data-input-scroll]";

    /**
     * DOM attribute on the composer card while a fold chip is mounted. The chip
     * itself lives in a floating layer (the overlay anchor is `height:0`), so it
     * would otherwise paint over the attachments row and the editor; this
     * attribute is what makes the card reserve a band for it instead.
     *
     * Now that expanding consumes the fold, the chip exists only while the text is
     * folded, so "chip mounted" and "collapsed" are the same condition — the chip
     * and the clamp share one lifetime.
     */
    const CHIP_ATTR = "data-dshps-chip";

    /** Top offset of the chip inside the card, in px — mirrors the card's own
     * stock `padding-top`. */
    const CHIP_TOP_PX = 8;
    /** Chip height in px. Two lines (content preview + action), matching the
     * reference chip rather than a single-line summary row. */
    const CHIP_HEIGHT_PX = 48;
    /** Gap between the chip and the content below it, in px. */
    const CHIP_GAP_PX = 4;
    /**
     * Top padding the card must carry while the chip is mounted, in px. Summed
     * from the parts rather than hard-coded so the chip can never drift into the
     * attachments row: this is the one number that keeps a floating chip from
     * overlapping in-flow content.
     */
    const CHIP_BAND_PX = CHIP_TOP_PX + CHIP_HEIGHT_PX + CHIP_GAP_PX;

    /**
     * Apply or remove the collapsed attribute on ONE session's composer card.
     *
     * `[data-composer-card]` is marked by the stock InputBar on the element
     * wrapping the whole composer, and the overlay anchor this component renders
     * into sits inside that same card, so the nearest ancestor is this session's
     * card and never another session's. Scoping by `sessionId` is therefore
     * automatic — the element is only ever reached from inside itself.
     *
     * Returns true when the card was found, so the caller can retry: the card can
     * legitimately be absent for a commit or two when a session is switching.
     *
     * @param collapsed - clamp the editor to the folded height.
     * @param hasChip - reserve the chip band. Defaults to `collapsed`; callers that
     *   pass it explicitly pass the same value, because the chip is gone once the
     *   fold is expanded.
     */
    function applyFoldToCard(anchor, collapsed, hasChip) {
      if (anchor === null || anchor === undefined) return false;
      const card = typeof anchor.closest === "function" ? anchor.closest("[data-composer-card]") : null;
      if (card === null) return false;
      if (collapsed) card.setAttribute(FOLD_ATTR, "");
      else card.removeAttribute(FOLD_ATTR);
      const chip = hasChip === undefined ? collapsed === true : hasChip === true;
      if (chip) card.setAttribute(CHIP_ATTR, "");
      else card.removeAttribute(CHIP_ATTR);
      return true;
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
      if (typeof candidate !== "string" || candidate === "") return "";
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
      for (let from = 0; ; ) {
        const at = current.indexOf(candidate, from);
        if (at < 0) break;
        if (best < 0 || Math.abs(at - diverge) < Math.abs(best - diverge)) best = at;
        from = at + 1;
      }
      // Not found means the editor normalized the paste on the way in, so there is
      // nothing to remove precisely; empty is the honest fallback.
      if (best < 0) return "";
      return current.slice(0, best) + current.slice(best + candidate.length);
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

    function createPasteInbox() {
      let pending = null;
      return {
        record(text, source) {
          if (typeof text !== "string" || text === "") return;
          pending = { text, bytes: utf8Bytes(text), at: Date.now(), source };
          if (source !== undefined) diag({ lastPasteSource: source, lastPasteBytes: utf8Bytes(text) });
        },
        /**
         * Consume the pending paste, or null when there is none.
         *
         * The age limit is what keeps a stale entry from being blamed for an
         * unrelated later edit: an entry is only ever meant for the very next
         * draft transition, which follows the insertion by a frame at most.
         */
        take(maxAgeMs = 4000) {
          const entry = pending;
          pending = null;
          if (entry === null) return null;
          if (Date.now() - entry.at > maxAgeMs) return null;
          return entry;
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
     * Decide what one draft transition means and perform it. This is the whole
     * detection layer, kept pure enough to test without a DOM.
     *
     * @returns "inline" | "fold" | "file".
     */
    function reactToDraft({ previous, current, run, recorded, removable, sessionId, conversation, shell, foldStore, expandStore, holdStore, index = 1, onUploadSettled }) {
      // The watcher is the single authority for the fold record's lifetime: it is
      // the only place that sees every draft revision, so it can clear the record
      // the moment the padded text is gone. The card deliberately does NOT rely on
      // reading the draft to notice this (see foldApplies), because its own draft
      // hook can be a permanently absent store.
      //
      // EXCEPT while a hold is active. Collapsing deliberately removes the text
      // from the draft, which is indistinguishable here from the user deleting it —
      // so without this guard the collapse would immediately retire the very record
      // the expand path restores from, and a collapse would become permanent data
      // loss. The hold is the authority on "the text is intentionally out of the
      // draft"; the watcher resumes owning the record once the hold is released.
      const held = holdStore !== undefined && holdStore !== null && holdStore.has(sessionId) === true;
      const staleRecord = sessionId !== undefined ? foldStore.getSnapshot()[sessionId] : undefined;
      if (!held && staleRecord !== undefined && !foldTextPresent(staleRecord, current)) {
        foldStore.clear(sessionId);
        // Keep the two stores in lockstep. Without this, expanding one fold and
        // then clearing the draft would leave the flag set, so the NEXT large paste
        // in this session would appear already expanded — a state the user never
        // asked for and cannot explain from what is on screen.
        if (expandStore !== undefined && expandStore !== null) expandStore.clear(sessionId);
      }
      const candidate = measurableText({ recorded, run, previous, current });
      if (candidate === null) {
        return "inline";
      }
      const verdict = decidePaste(candidate);
      if (verdict.action === "inline") return "inline";
      if (verdict.action === "fold") {
        if (sessionId !== undefined) {
          // The record is the WHOLE fold state, and writing it is the only side effect.
          //
          // Nothing here touches the editor. That is the point of this design: an
          // earlier version replaced the draft with a `ReferenceChipNode` so the
          // composer would show a chip, and every bug in it came from that mutation --
          // the revision CAS, the detect-vs-clipboard span coordinates, the atomic
          // node orphaned without a record, and a repeat paste whose whole-draft span
          // swallowed the previous chip. The text now simply STAYS in the editor and is
          // hidden with CSS, so there is no editor state to get wrong. Typing, the
          // caret, undo, and repeated pastes all behave exactly as they do without
          // this plugin, which is the requirement.
          //
          // Sending is unaffected: stock serializes `fx.draft` as a `text` block, and CSS
          // is presentation only -- so the message body is the pasted text verbatim,
          // while the composer shows a clamped, chipped appearance.
          //
          // The ref must be unique per fold: several folds can measure the same byte
          // count, so a ref built from bytes alone would collide and make two records
          // indistinguishable.
          // A bare timestamp is NOT a sufficient identity: two pastes can land in the same
          // millisecond, which made two folds share a ref -- so the second fold was
          // indistinguishable from the first and its chip never appeared. A monotonic
          // counter is mixed in so identity never depends on clock resolution.
          foldRefSeq += 1;
          const chipRef = `${sessionId}:${verdict.bytes}:${Date.now().toString(36)}:${foldRefSeq.toString(36)}`;
          // `sentinels` are the substrings whose presence in the draft means this fold is
          // still live. Both the measured run and the whole draft are registered, because
          // the two can differ: the run is a fragment when the paste replaced similar
          // text, and the draft is the safer signal when the editor normalized the
          // insertion on the way in. A LIST rather than one best guess is what makes the
          // record's lifetime robust to either case.
          const candidateSentinels = candidate === current ? [current] : [candidate, current];
          // Prefer the text the user actually pasted (captured on beforeinput/paste),
          // then the located diff, and only fall back to the measurement.
          const foldText =
            recorded !== null && recorded !== undefined && typeof recorded.text === "string" && recorded.text !== ""
              ? recorded.text
              : typeof removable === "string" && removable !== "" && removable !== current
                ? removable
                : typeof run === "string" && run !== null && run !== "" && run !== current
                  ? run
                  : candidate;
          // The record is a LIST per session, because the user can paste several large
          // runs into one composer and each earns its own chip. Collapsing them into one
          // record was why a repeat paste replaced the previous fold instead of joining it.
          const existing = foldStore.getSnapshot()[sessionId];
          const folds = Array.isArray(existing && existing.folds) ? existing.folds.slice() : [];
          folds.push({
            ref: chipRef,
            bytes: verdict.bytes,
            lines: countLines(candidate),
            sentinels: candidateSentinels,
            // The exact text this chip's x removes from the composer. It is a genuine
            // substring of the draft, which is what keeps x from deleting unrelated text.
            text: foldText,
          });
          foldStore.set(sessionId, {
            // Kept for the clamp and for older readers: the LAST fold's numbers.
            bytes: verdict.bytes,
            lines: countLines(candidate),
            sentinels: candidateSentinels,
            text: foldText,
            chipRef,
            chipInserted: false,
            folds,
          });
          diag({
            foldStoredBytes: verdict.bytes,
            foldStoredFromPaste: recorded !== null && recorded !== undefined,
            foldCount: folds.length,
            foldStoredTextLen: typeof foldText === "string" ? foldText.length : undefined,
            foldStoredDraftLen: typeof current === "string" ? current.length : undefined,
          });
        }

        return "fold";
      }
      if (sessionId === undefined || conversation === undefined || conversation === null || shell === undefined || shell === null) {
        return "inline";
      }
      let started;
      try {
        started = uploadPaste({
          conversation,
          sessionId,
          shell,
          text: candidate,
          index,
          onReady: () => {
            if (onUploadSettled !== undefined) onUploadSettled(true);
          },
          onFailure: () => {
            if (onUploadSettled !== undefined) onUploadSettled(false);
          },
        });
      } catch {
        return "inline";
      }
      return started === false ? "inline" : "file";
    }

    /** Monotonic tiebreaker so two folds in the same millisecond get distinct refs. */
    let foldRefSeq = 0;

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
    function watchDraft({ shell, foldStore, expandStore, holdStore, sessionId, conversation, nextIndex, onRestore, onSendCommitted, inbox }) {
      if (shell === undefined || shell === null || shell.state === undefined) return () => {};
      const store = shell.state;
      const initial = store.getSnapshot();
      let previous = typeof initial?.draft === "string" ? initial.draft : "";
      let lastRev = initial?.draftRev;
      // Set while we write to the draft ourselves, so our own publish does not
      // re-enter this subscriber as if the user had typed.
      let restoring = false;
      return store.subscribe(() => {
        if (restoring) return;
        const snapshot = store.getSnapshot();
        if (snapshot === undefined || snapshot === null) return;
        const current = typeof snapshot.draft === "string" ? snapshot.draft : "";
        const sameRev = snapshot.draftRev !== undefined && snapshot.draftRev === lastRev;
        // A COMPLETED SEND clears everything this plugin owns for the session.
        //
        // Display-only folding makes this simple and robust. The text lives in the
        // composer, so a send empties the draft via stock's ordinary commit -- one
        // notification, one signal, and it arrives on a revision change. The older
        // design needed a fragile "our attachment ids are gone" test because the
        // text was NOT in the draft and an emptied composer looked exactly like a
        // collapse; with no attachment in play there is nothing left to guess at.
        //
        // This still must run before the revision guard: stock's send publishes once
        // and the guard exists to suppress repeat work, not to filter the signal.
        if (typeof onSendCommitted === "function") {
          const folded = foldStore.getSnapshot()[sessionId] !== undefined;
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
        const recorded = inbox.take();
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
          expandStore,
          holdStore,
          index: nextIndex(),
          onUploadSettled: (ok) => {
            if (ok !== true) return;
            try {
              restoring = true;
              // Remove just the pasted text: a spill can equally have been an
              // append or a replacement, and clearing the whole draft would
              // discard unrelated text in the append case.
              const cleaned = removePastedText(current, removable, beforePaste);
              previous = cleaned;
              shell.setDraft(cleaned);
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
     * Chip for the fold layer, rendered INSIDE the composer card, in a band of its
     * own directly above the attachments row and the editor.
     *
     * It is the ONLY affordance for a 4000–50000 byte paste, and it has exactly two
     * outcomes:
     *
     *   - click the body  -> the held text is written back into the composer and
     *                        this chip unmounts (nothing is folded any more)
     *   - click the ×     -> the paste is DELETED: hold released and the sidecar
     *                        attachment detached
     *
     * While it is on screen the composer is EMPTY — folding really does take the
     * text out of the draft and hand it to the plugin (see the hold store). That is
     * why the sidecar attachment exists: stock serializes the live editor with no
     * hook to intercept, so an emptied composer would otherwise submit nothing.
     *
     * Why ONE component for both jobs. The previous build split them: a card in
     * `conversation.input.dock` and a marker in `conversation.input.overlay`. That
     * dock slot renders as a SIBLING ABOVE [data-composer-card], so the card could
     * only ever appear outside the input box — which is exactly what was rejected.
     * `conversation.input.overlay` is the only slot that renders inside the card,
     * so the visible affordance and the attribute both come from here.
     *
     * `usePasteFold` arrives as a SELECTOR hook bound by the renderer
     * (`observableHook` -> useSyncExternalStoreWithSelector), so it must be called
     * with a selector and it must be called on every render. It is the chip's only
     * data source: the watcher clears the record when the folded text leaves the
     * draft, which is what hides the chip.
     */
    function PasteFoldChip({ sessionId, usePasteFold, useFoldExpanded, setFoldExpanded, onToggle, onDismiss, getHeld, t }) {
      const record = readSessionSlice(usePasteFold, sessionId);
      const expanded = readSessionSlice(useFoldExpanded, sessionId);
      const present = foldApplies(record) || (typeof getHeld === "function" && getHeld(sessionId) !== undefined);
      // An expanded chip cannot be shown: expanding consumes the fold, so `expanded`
      // is only ever transiently true mid-click and never true for a mounted chip.
      // Kept in the visibility test anyway so a stale flag from an older build can
      // never pin a chip on screen for text that is already back in the composer.
      const collapsed = present && expanded !== true;
      const anchorRef = React.useRef(null);
      // ONE toggle for both the chip and the faded band, so "expand" can never mean
      // "flip a flag" in one place and "write the text back" in another. Expanding
      // is a real edit (the text is physically out of the editor), which makes that
      // distinction the difference between restoring the user's paste and losing it.
      const applyToggle = (next) => {
        if (typeof onToggle === "function") onToggle(sessionId, next);
        if (typeof setFoldExpanded === "function") setFoldExpanded(sessionId, next);
      };
      // Dismiss is its own action, never routed through the toggle: "关闭即删除"
      // and "展开写回" are opposites, and sharing a callback would make the × a
      // coin flip between them.
      // Passes the chip's own ref, so × removes just that paste. A session-level dismiss
      // would delete every fold at once, which is not what removing one rail item means.
      const applyDismiss = (foldRef) => {
        if (typeof onDismiss === "function") onDismiss(sessionId, foldRef);
      };

      // useLayoutEffect, not useEffect: the attributes must be on the card in the
      // same commit that reveals the fold, otherwise the first paint shows the
      // full 40k paste and then snaps shut. Both attributes pass the same value:
      // the chip and the collapsed clamp now share a lifetime, because expanding
      // removes the chip.
      React.useLayoutEffect(() => {
        applyFoldToCard(anchorRef.current, collapsed, collapsed);
      }, [collapsed]);

      // Expand when the user clicks the faded band at the bottom of the clamped
      // editor. Bound in the CAPTURE phase on the scroll container so the caret is
      // never placed first (which would scroll the container and move the band out
      // from under the pointer between mousedown and mouseup).
      //
      // Only the band toggles: a click anywhere in the visible lines falls through
      // untouched. `preventDefault` is called only once the hit-test has already
      // decided this is the band, so normal clicking is never affected.
      React.useEffect(() => {
        if (!collapsed) return undefined;
        try {
          const anchor = anchorRef.current;
          const card = anchor === null ? null : anchor.closest("[data-composer-card]");
          const scroll = card === null ? null : card.querySelector(SCROLL_SELECTOR);
          if (scroll === null) return undefined;
          const onMouseDown = (event) => {
            const rect = scroll.getBoundingClientRect();
            // The band is the bottom FADE_PX of the container, which at 84px
            // clamped height is also where the mask has already faded to nothing.
            if (event.clientY < rect.bottom - FADE_PX) return;
            event.preventDefault();
            applyToggle(true);
          };
          scroll.addEventListener("mousedown", onMouseDown, true);
          return () => scroll.removeEventListener("mousedown", onMouseDown, true);
        } catch {
          return undefined;
        }
      }, [collapsed, sessionId, setFoldExpanded]);
      // Cleanup is separate so it also runs on unmount/teardown, when the session
      // switches away: leaving the attributes behind would clamp the NEXT session's
      // composer with nothing painted to explain it, and a stale band would indent
      // its content for a chip that is not there.
      React.useEffect(
        () => () => {
          applyFoldToCard(anchorRef.current, false, false);
        },
        [],
      );

      const label = t === undefined ? (key) => key : t;
      const open = expanded === true;
      // ONE CHIP PER FOLD, like the image rail.
      //
      // Reads the fold LIST the watcher records. Several large pastes into one composer
      // each earn their own chip, which is the multi-paste behaviour the image chip has:
      // "支持多次粘贴". A single-chip renderer was why a repeat paste looked like nothing
      // happened.
      // A record written by an older build has no `folds` list; treat the record itself
      // as a single fold so such a state still renders a chip instead of nothing.
      const folds = Array.isArray(record && record.folds)
        ? record.folds
        : record !== undefined && record !== null
          ? [record]
          : [];
      // The collapsed clamp belongs to the card, not to one chip, so it is driven once
      // from whether ANY fold exists.
      const anyFold = folds.length > 0 || present;
      return React.createElement(
        React.Fragment,
        null,
        // The zero-size locator. Always rendered, even with no record, because the
        // effects above need a mounted node to reach the card from (and to clear
        // the attributes from on teardown).
        React.createElement("div", {
          ref: anchorRef,
          className: "dshps-fold-anchor",
          "data-paste-spill-anchor": true,
          "aria-hidden": true,
        }),
        anyFold
          ? React.createElement(
              "div",
              { className: "dshps-chip-rail", "data-paste-spill-rail": true },
              ...folds.map((fold, index) => {
                const foldRef = fold.ref;
                const foldPreview = foldPreviewOf(fold);
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
                      // Was the text put back into the composer? The chip is only mounted
                      // while it is collapsed, so this is false in practice -- but it is
                      // the honest state for assistive tech, and it is what the affordance
                      // reports.
                      "aria-expanded": open === true,
                      // "按原文发送" lives on the expand control's tooltip. A build that
                      // rendered it as a paragraph above the input box was rejected.
                      title: label("foldHint"),
                      onClick: (event) => {
                        if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
                        applyToggle(true);
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
                        foldPreview === "" ? label("foldTitle") : foldPreview,
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
              }),
            )
          : null,
      );
    }

    /**
     * Human-readable byte size for the chip's label.
     * @param bytes - UTF-8 size.
     * @returns e.g. "6.0 KB".
     */
    function formatFoldSize(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      const kb = bytes / 1024;
      if (kb < 1000) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
      return `${(kb / 1024).toFixed(1)} MB`;
    }



    /**
     * @param ctx - client plugin context.
     */
    exports.apply = function apply(ctx) {
      // Boot marker FIRST, before anything that could throw.
      //
      // It used to sit at the end of apply(). When the diagnostics key went missing
      // while the chip still rendered, that placement made the two possible causes
      // indistinguishable: "apply never ran" and "apply threw halfway through, after
      // the slot was registered" both produced no key. Writing it first separates
      // them, and applyFailures below records the other case explicitly.
      diag({ build: BUILD_REV, applyRanAt: Date.now() });
      const foldStore = createSessionStore();
      // Separate store from the fold record on purpose: "is text folded here" and
      // "has the user opened it up" have different lifetimes. Collapsing must not
      // be resurrected when the watcher rewrites the record on a later keystroke,
      // and clearing the fold must not leave a stale expanded flag behind.
      const expandStore = createSessionStore();
      // The text a collapse has taken out of the editor. Its own store because its
      // lifetime is the inverse of the fold record's: a hold by definition means the
      // text is NOT in the draft, so it cannot ride on the record (which the watcher
      // retires exactly when text leaves the draft).
      const holdStore = createHoldStore();
      /**
       * Attachment ids the sidecar admitted, per session. Tracked so the chip's ×
       * can detach exactly the file this collapse attached: "关闭即删除" has to
       * delete the paste from the SUBMISSION too, not just from the composer.
       */
      /**
       * Collapse/expand the fold. PURELY VISUAL -- no draft write, no attachment.
       *
       * The text never leaves the composer, so "collapse" and "expand" only move the
       * `data-dshps-folded` attribute that clamps the editor's height in CSS. That is
       * what makes the fold safe: whatever the user does next, the composer holds the
       * real text, so a send posts the original message with no file chip.
       *
       * The previous design emptied the editor here and attached a `sidecar` file so
       * an empty composer could still submit. Both halves were defects for this layer:
       * the text visibly vanished when the user had asked only for a change of
       * appearance, and the attachment rendered as a JSON file chip in the turn. The
       * orphaned sidecar also kept the send button enabled over an emptied composer,
       * so pressing send posted that JSON.
       */
      const toggleFold = (sessionId, next) => {
        if (sessionId === undefined || sessionId === null) return;
        // Expanding and collapsing are now PURELY VISUAL.
        //
        // The text never left the composer -- that is the whole design -- so there is
        // nothing to write back and nothing to restore. Expanding just drops the fold
        // state so the CSS clamp lifts and the chip unmounts, revealing the text that was
        // in the editor all along.
        //
        // This is what removes the entire class of bug the old expand path had: no
        // `setDraft`, so no rebuilt editor, no caret to lose, no undo history to reset,
        // and no placeholder that could survive as an orphan. It also means an expand can
        // never lose text, because it never moves any.
        foldStore.clear(sessionId);
        expandStore.clear(sessionId);
        holdStore.clear(sessionId);
        diag({ manualExpand: "expanded", foldExpandRestored: false, foldExpandSource: "text-stayed-in-draft" });
      };
      const setFoldExpanded = (sessionId, next) => {
        if (sessionId === undefined || sessionId === null) return;
        if (next) expandStore.set(sessionId, true);
        else expandStore.clear(sessionId);
      };
      /**
       * The chip's × handler: "关闭即删除" -- the × discards the paste for real.
       *
       * Deletes the TEXT from the composer, not merely the chip. Display-only folding
       * means the text is still in the editor while collapsed, so a × that only
       * unmounted the chip would leave the paste sitting in the input box that the
       * user just discarded.
       */
      const dismissSessionFold = (sessionId, foldRef) => {
        if (sessionId === undefined || sessionId === null) return;
        const record = foldStore.getSnapshot()[sessionId];
        const all = Array.isArray(record && record.folds)
          ? record.folds
          : record !== undefined && record !== null
            ? [record]
            : [];
        // Remove just the named chip. With several pastes in one composer, × on one rail
        // item must delete only THAT paste -- removing the whole fold state would wipe the
        // other pastes' text as well.
        const target = typeof foldRef === "string" ? all.find((f) => f.ref === foldRef) : all[all.length - 1];
        if (target === undefined || target === null) return;
        const text = typeof target.text === "string" ? target.text : "";
        const shell = shellOf(ctx, sessionId);
        const outcome = dismissFold({
          sessionId,
          holdStore,
          // Delete exactly this fold's text from the composer. `removePastedText` refuses a
          // candidate that is the whole draft with a pre-existing prefix, so a bogus target
          // degrades to leaving the text rather than clearing everything.
          removeText: (current) => {
            if (text === "") return current;
            return removePastedText(current, text, "");
          },
          writeDraft: (next) => {
            if (shell === null || typeof shell.setDraft !== "function") return false;
            shell.setDraft(next);
            return true;
          },
          readDraft: () => {
            const draft = shell === null ? undefined : shell.state?.getSnapshot()?.draft;
            return typeof draft === "string" ? draft : "";
          },
          // Drop only this fold from the list; the session's fold state survives for the
          // other chips.
          clearFold: () => {
            const remaining = all.filter((f) => f !== target);
            if (remaining.length === 0) {
              foldStore.clear(sessionId);
              expandStore.clear(sessionId);
              return;
            }
            // Keep the convenience fields pointing at the newest surviving fold.
            const last = remaining[remaining.length - 1];
            foldStore.set(sessionId, {
              bytes: last.bytes,
              lines: last.lines,
              sentinels: last.sentinels,
              text: last.text,
              chipRef: last.ref,
              chipInserted: false,
              folds: remaining,
            });
          },
          // × is a deletion, so the held text goes with it. Only for a real chip: a
          // clamp-only fold never held anything.
          releaseChip: () => {
            if (typeof target.ref === "string") releaseFoldText(target.ref);
          },
        });
        diag({ foldDismissed: outcome, foldDismissedRef: foldRef, foldRemaining: foldStore.getSnapshot()[sessionId]?.folds?.length ?? 0 });
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
                else inbox.record(transfer.getData("text/plain"), "beforeinput");
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
              else inbox.record(clipboard.getData("text/plain"), "paste");
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
      const pending = new Set();
      let retryFrame = null;
      let retriesLeft = 0;

      const tryInstall = (sessionId) => {
        if (watchers.has(sessionId)) return true;
        const shell = shellOf(ctx, sessionId);
        if (shell === null) return false;
        watchers.set(
          sessionId,
          watchDraft({
            shell,
            foldStore,
            expandStore,
            holdStore,
            sessionId,
            conversation: ctx.conversation,
            nextIndex,
            inbox,
            onRestore: () => diag({ spilledTextRemoved: true }),
            // Remember the sidecar ids so the chip's × can detach them: dismissing
            // must delete the paste from the submission, not only the composer.
            // A completed send retires everything this plugin owns for the session.
            // Stock has already cleared the draft and taken the attachments, so
            // there is nothing to restore and nothing to detach: the sidecar went
            // out WITH the message. Only our own bookkeeping survives, and it must
            // not, or the next paste inherits it.
            onSendCommitted: () => {
              holdStore.clear(sessionId);
              foldStore.clear(sessionId);
              expandStore.clear(sessionId);
              // The ids are dropped rather than detached: the attachment was
              // submitted, so detaching it now would be deleting a file the user
              // just sent. (removeAttachment on a committed id is also a no-op, but
              // relying on that would be luck, not design.)
            },
          }),
        );
        return true;
      };

      const scheduleRetry = () => {
        if (typeof requestAnimationFrame !== "function") return;
        retriesLeft = Math.max(retriesLeft, 120); // ~2s at 60fps
        if (retryFrame !== null) return;
        const tick = () => {
          retryFrame = null;
          for (const id of [...pending]) {
            if (tryInstall(id)) pending.delete(id);
          }
          if (pending.size > 0 && retriesLeft > 0) {
            retriesLeft -= 1;
            retryFrame = requestAnimationFrame(tick);
          }
        };
        retryFrame = requestAnimationFrame(tick);
      };

      const ensureWatcher = (sessionId) => {
        if (sessionId === undefined || sessionId === null) return;
        if (tryInstall(sessionId)) {
          pending.delete(sessionId);
          return;
        }
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
          for (const stop of watchers.values()) {
            try {
              stop();
            } catch {
              /* teardown is best-effort */
            }
          }
          watchers.clear();
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
          // Hide stock's OWN inline rendering of our chip node.
          //
          // A reference node is painted twice over: stock draws it inline in the
          // editor flow via `ReferenceChip` (`.QiNVUW_chip`, a compact 22px pill), and
          // we draw the real affordance as the floating overlay below. Left alone the
          // user sees both at once -- the stock pill ("已折叠 5.9 KB") AND our chip --
          // which reads as the paste having been split into two separate blocks.
          //
          // Scoping is the whole difficulty: stock's chip DOM carries only
          // `title={label}` (no source or ref attribute), so the label is the only
          // discrimin-ator available. `title^="已折叠 "` is safe because labels come
          // from registered sources, and no other installed package emits that prefix
          // (checked against every @deepseek-ai/* package). Matching on the stock
          // class as well keeps the rule from touching anything else that happens to
          // carry a similar title.
          //
          // `display:none` rather than `visibility:hidden`: the node must stop
          // occupying inline space, or the text area would still reserve a 22px line
          // for a pill nobody can see.
          "[data-composer-card] .QiNVUW_chip[title^=\"已折叠 \"]{display:none}" +
          // The chip floats (the overlay anchor is `height:0`), so it cannot occupy
          // the flow itself. These two rules are a pair: the chip is positioned in
          // the band, and the card reserves exactly that band as padding. Sizing the
          // band from the same constants the chip is positioned with is what keeps
          // the chip from ever painting over the attachments row.
          "[data-composer-card][" + CHIP_ATTR + "]{padding-top:" + CHIP_BAND_PX + "px}" +
          // The RAIL: the band that holds one chip per fold, laid out like the image rail
          // (dsh-client-ui-attachment's rail) -- a wrapping row of items above the editor.
          // Absolute so it does not disturb the composer's own flow; the card's padding-top
          // (above) reserves exactly this band, so the chips never paint over the editor.
          ".dshps-chip-rail{position:absolute;top:" + CHIP_TOP_PX + "px;left:12px;right:12px;" +
          "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;z-index:1}" +
          // Each chip is a rail item: `position:static` so it participates in the wrap
          // (the old absolute positioning pinned exactly one chip to one spot, which is
          // why several folds could not be shown at once).
          ".dshps-chip{position:static;" +
          // Hug the content (a compact chip, like the attachment chip it imitates)
          // but never extend past the card. `right` stays auto: with both sides
          // pinned the chip would stretch into a full-width bar.
          "width:fit-content;max-width:calc(100% - 24px);" +
          "height:" + CHIP_HEIGHT_PX + "px;box-sizing:border-box;" +
          // Mirrors dsh-client-ui-attachment's chip (GD8l4q_card) so it reads as one
          // of the composer's own affordances rather than a plugin banner.
          "border:.5px solid var(--dsw-alias-border-l2,#0000001f);" +
          "background:var(--dsw-specific-input-major,transparent);" +
          "border-radius:12px;align-items:center;display:flex;" +
          "text-align:left;font:inherit;color:inherit;overflow:hidden;z-index:1}" +
          ".dshps-chip:hover{border-color:var(--dsw-alias-border-l1,#00000033)}" +
          // The body is the expand affordance: a flat button filling the chip so the
          // whole surface (except the × corner) is the click target.
          ".dshps-chip-open{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:10px;" +
          "height:100%;padding:0 4px 0 10px;border:none;background:transparent;font:inherit;" +
          "color:inherit;cursor:pointer;text-align:left}" +
          ".dshps-chip-open:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-2px;border-radius:12px}" +
          ".dshps-chip-glyph{flex:none;display:inline-flex;align-items:center;justify-content:center;" +
          "width:24px;height:24px;border-radius:6px;background:var(--dsw-alias-bg-base,#0000000a);" +
          "color:var(--dsw-alias-label-secondary)}" +
          // Two stacked lines: the content preview on top, the action underneath —
          // the reference chip's shape. Both single-line, so the fixed height holds.
          ".dshps-chip-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}" +
          ".dshps-chip-preview{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;" +
          "white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}" +
          ".dshps-chip-action{display:flex;align-items:center;gap:2px;color:var(--dsw-alias-label-tertiary);" +
          "font-size:12px;line-height:16px;white-space:nowrap}" +
          ".dshps-chip-chevron{flex:none;font-size:11px}" +
          // "关闭即删除": a small circular × in the chip's top-right, like the
          // reference. Sized and padded to stay a comfortable hit target.
          ".dshps-chip-dismiss{flex:none;display:inline-flex;align-items:center;justify-content:center;" +
          "width:20px;height:20px;margin-right:8px;padding:0;border:none;border-radius:999px;" +
          "background:var(--dsw-alias-label-primary,#000);color:var(--dsw-alias-bg-base,#fff);" +
          "font-size:13px;line-height:1;cursor:pointer;opacity:.85}" +
          ".dshps-chip-dismiss:hover{opacity:1}" +
          ".dshps-chip-dismiss:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}" +
          // The anchor itself must occupy no space and never intercept a click; it
          // exists only to locate the composer card from inside it.
          ".dshps-fold-anchor{height:0;width:0;pointer-events:none}" +
          // The sidecar file card is HIDDEN, not dropped: the user wants the chip
          // alone ("不需要下部分的文件，只保留上部分内容"), but the attachment is
          // what carries the text into a submission made from the emptied composer,
          // so removing it would send nothing.
          //
          // Matched by the card's own `title` attribute, which stock sets to the
          // file NAME, and scoped inside `[data-composer-card]` so the rule cannot
          // reach a same-named element elsewhere. The prefix is ours alone
          // (`pasted-text-`), so a user's genuine attachments are untouched --
          // `display:none` rather than `visibility` so the card takes no space and
          // leaves no gap where it used to sit.
          // Collapsed editor, CLAMP-ONLY fallback: when a chip could not be inserted the
          // text stays inline, and this clamps it to ~2 lines with a faded cut edge
          // so the fold still reads as a fold. `:not([data-dshps-chip])` keeps this
          // off a chip fold, where the editor is empty and clamping would only
          // squeeze the chip's own band.
          "[data-composer-card][" + FOLD_ATTR + "]:not([" + CHIP_ATTR + "]) " + SCROLL_SELECTOR + "{" +
          "max-height:" + FOLD_CLAMP_PX + "px;" +
          "mask-image:linear-gradient(to bottom,#000 calc(100% - " + FADE_PX + "px),transparent);" +
          "-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - " + FADE_PX + "px),transparent);" +
          "cursor:pointer}"
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
              // is the chip's ONLY source. It deliberately does not also read the
              // session's draft: that hook is materialized once per session binding
              // and cached, so a binding created before the shell existed would hold
              // a permanently absent store and hide the chip even with a valid
              // record. The draft watcher, which demonstrably sees every revision,
              // clears the record instead.
              hooks: { pasteFold: foldStore, foldExpanded: expandStore },
              setFoldExpanded,
              // The restore-aware toggle. `onToggle` is what makes the chip's click
              // press the real edit (write the text back), and `getHeld` is how the
              // chip previews content after the record is retired by the collapse.
              // Both are plain functions, not stores: the chip does not need to
              // re-render on a hold change, it re-renders on the fold store.
              onToggle: toggleFold,
              onDismiss: dismissSessionFold,
              getHeld: (id) => holdStore.get(id),
            }),
          },
          PasteFoldChip,
        ),
      );
    };
    // `inputTriggers` is the root half of stock's trigger pipeline (the source
    // roster behind `@` and `/`). The fold layer needs it because a chip is the
    // only way to place something in the composer that is not literal text: the
    // chip node contributes a lone U+FFFC placeholder to the draft, which keeps
    // `draft.trim() !== ""` (so the send button stays live) while the real text
    // travels beside the draft and is re-serialized at submit time.
    exports.inject = ["slots", "conversation", "sessions", "locale", "inputTriggers"];
    exports.__internals = {
      FOLD_BYTES,
      SPILL_BYTES,
      PREVIEW_CHARS,
      PASTE_NAME_PREFIX,
      formatFoldSize,
      utf8Bytes,
      decidePaste,
      countLines,
      pasteFileName,
      foldTextPresent,
      foldApplies,
      restoreTextFor,
      describeDraft,
      holdApplies,
      createHoldStore,
      dismissFold,
      foldPreview,
      foldPreviewOf,
      readSessionSlice,
      applyFoldToCard,
      FOLD_ATTR,
      CHIP_ATTR,
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
    };
    return module.exports;
  },
});
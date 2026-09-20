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
    /** Filename prefix the host half recognizes. Keep in sync with dsh-paste-spill. */
    const PASTE_NAME_PREFIX = "pasted-text-";
    const NS = "dsh-paste-spill";
    /** The composer's contenteditable surface — how we recognize paste targets. */
    const COMPOSER_SELECTOR = "[data-composer-input]";
    /** Bumped by hand so the boot marker identifies the exact build in the GUI. */
    const BUILD_REV = "input-dock-1";
    /** Debug channel. The renderer partition's Local Storage is readable from the
     * host, so this is the only way to get in-app ground truth without a console. */
    const DIAG_KEY = "dsh.paste-spill.diag";

    function diag(patch) {
      try {
        const raw = window.localStorage.getItem(DIAG_KEY);
        const next = raw === null ? {} : JSON.parse(raw);
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

    const zh = {
      foldTitle: "已折叠大文本",
      foldMeta: "{bytes} 字节 · {lines} 行",
      foldHint: "全文仍在输入框中，提交时按原样发送",
    };
    const en = {
      foldTitle: "Large text folded",
      foldMeta: "{bytes} bytes · {lines} lines",
      foldHint: "The full text stays in the composer and is sent as-is",
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
    function reactToDraft({ previous, current, run, recorded, sessionId, conversation, shell, foldStore, index = 1, onUploadSettled }) {
      // The watcher is the single authority for the fold record's lifetime: it is
      // the only place that sees every draft revision, so it can clear the record
      // the moment the padded text is gone. The card deliberately does NOT rely on
      // reading the draft to notice this (see foldApplies), because its own draft
      // hook can be a permanently absent store.
      const staleRecord = sessionId !== undefined ? foldStore.getSnapshot()[sessionId] : undefined;
      if (staleRecord !== undefined && !foldTextPresent(staleRecord, current)) foldStore.clear(sessionId);
      const candidate = measurableText({ recorded, run, previous, current });
      if (candidate === null) {
        return "inline";
      }
      const verdict = decidePaste(candidate);
      if (verdict.action === "inline") return "inline";
      if (verdict.action === "fold") {
        if (sessionId !== undefined) {
          // `sentinels` are the substrings whose absence means the folded text has
          // left the draft; the watcher clears the record on that. Both the
          // measured run and the whole draft are registered, because the two can
          // differ: the run is a fragment when the paste replaced similar text,
          // and the draft is the safer signal when the editor normalized the
          // insertion on the way in. Keeping them as a list rather than one
          // "best guess" is what makes the card's lifetime robust to either case.
          const sentinels = candidate === current ? [current] : [candidate, current];
          foldStore.set(sessionId, {
            bytes: verdict.bytes,
            lines: countLines(candidate),
            sentinels,
          });
          diag({
            foldStoredSessionId: sessionId,
            foldStoredBytes: verdict.bytes,
            foldStoredFromPaste: recorded !== null && recorded !== undefined,
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
    function watchDraft({ shell, foldStore, sessionId, conversation, nextIndex, onRestore, inbox }) {
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
        if (snapshot.draftRev !== undefined && snapshot.draftRev === lastRev) return;
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
          sessionId,
          conversation,
          shell,
          foldStore,
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
     * Dock card for the fold layer. It is a HINT, never a replacement: the full
     * text stays in the editor and is submitted verbatim, which is what keeps
     * slash-command and goal parsing identical to a plugin-free install.
     *
     * `usePasteFold` arrives as a SELECTOR hook bound by the renderer
     * (`observableHook` -> useSyncExternalStoreWithSelector), so it must be called
     * with a selector and it must be called on every render. It is the card's only
     * data source: the watcher clears the record when the folded text leaves the
     * draft, which is what hides the card.
     */
    function PasteFoldCard({ sessionId, usePasteFold, t }) {
      const record = usePasteFold((state) => (state === undefined || state === null ? undefined : state[sessionId]));
      if (!foldApplies(record)) return null;
      const label = t === undefined ? (key) => key : t;
      return React.createElement(
        "div",
        {
          className: "dshps-fold-card",
          "data-paste-spill-fold": true,
        },
        React.createElement(
          "div",
          { className: "dshps-fold-row" },
          React.createElement("span", { className: "dshps-fold-title" }, label("foldTitle")),
          React.createElement(
            "span",
            { className: "dshps-fold-meta" },
            label("foldMeta", { bytes: record.bytes, lines: record.lines }),
          ),
        ),
        React.createElement("div", { className: "dshps-fold-hint" }, label("foldHint")),
      );
    }

    /**
     * @param ctx - client plugin context.
     */
    exports.apply = function apply(ctx) {
      const foldStore = createSessionStore();
      let counter = 0;
      const nextIndex = () => {
        counter += 1;
        return counter;
      };
      // Boot marker: proves the running renderer holds THIS build, which is what
      // made "the plugin was never loaded" distinguishable from "it loaded and
      // silently did nothing". Cheap, once per page load.
      diag({ build: BUILD_REV, applyRanAt: Date.now() });

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
            sessionId,
            conversation: ctx.conversation,
            nextIndex,
            inbox,
            onRestore: () => diag({ spilledTextRemoved: true }),
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
        if (document.querySelector(selector) !== null) return () => {};
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-paste-spill";
        tag.dataset.pluginCss = "dsh-paste-spill";
        tag.textContent =
          // Geometry mirrors the stock QueueDock (the other shipped occupant of this
          // same slot, ui-conversation QueueDock.module.css) so the card lines up
          // with the row above the input bar instead of overflowing it.
          ".dshps-fold-card{box-sizing:border-box;" +
          "width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));" +
          "max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));" +
          "margin:0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);padding:6px 12px;flex:none;" +
          "border:.5px solid var(--dsw-alias-border-l1);border-radius:12px 12px 0 0;" +
          "background:var(--dsw-specific-tip);color:var(--dsw-alias-label-primary);" +
          "font-size:13px;line-height:20px;overflow:hidden}" +
          ".dshps-fold-row{display:flex;align-items:center;gap:10px}" +
          ".dshps-fold-title{font-weight:500}" +
          ".dshps-fold-meta{color:var(--dsw-alias-label-tertiary)}" +
          ".dshps-fold-hint{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}" +
          ".dshps-fold-card + *{margin-top:0}"
        document.head.appendChild(tag);
        return () => tag.remove();
      }, "dsh-paste-spill: styles");

      // Registered on `conversation.input.dock`, NOT `conversation.composer.dock`.
      //
      // Verified in the shipped bundle: composer.dock is rendered only under
      // `variant === "composer" && input !== void 0 && sessionId !== void 0`, and
      // the variant is "hero" whenever `sessionId === void 0 || shellPhase ===
      // "blank" && ...` — so in a BLANK session (exactly where a big paste is
      // first tried) that slot never renders at all, and the card could not
      // appear no matter what the store held. input.dock is rendered on
      // `zone !== void 0`, independent of the variant, which is why the
      // attachment chip and the stock todo/queue docks all show up there.
      ctx.slots.inject("conversation.input.dock", () =>
        ctx.slots.register(
          {
            name: "conversation.input.dock",
            id: "paste-spill",
            order: 10,
            locale: NS,
            inject: (sessionId) => ({
              sessionId,
              // A store, NOT a plain function: the renderer wraps every hook source
              // in observableHook -> useSyncExternalStoreWithSelector. The fold store
              // is the card's ONLY source. It deliberately does not also read the
              // session's draft: that hook is materialized once per session binding
              // and cached, so a binding created before the shell existed would hold
              // a permanently absent store and hide the card even with a valid
              // record. The draft watcher, which demonstrably sees every revision,
              // clears the record instead.
              hooks: { pasteFold: foldStore },
            }),
          },
          PasteFoldCard,
        ),
      );
    };
    exports.inject = ["slots", "conversation", "sessions", "locale"];
    exports.__internals = {
      FOLD_BYTES,
      SPILL_BYTES,
      PASTE_NAME_PREFIX,
      utf8Bytes,
      decidePaste,
      countLines,
      pasteFileName,
      foldTextPresent,
      foldApplies,
      createSessionStore,
      insertedRun,
      measurableText,
      removePastedText,
      createPasteInbox,
      spillFile,
      uploadPaste,
      reactToDraft,
      watchDraft,
      PasteFoldCard,
    };
    return module.exports;
  },
});
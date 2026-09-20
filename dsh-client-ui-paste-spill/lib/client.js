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
    /** The composer's contenteditable surface — the only paste target we handle. */
    const COMPOSER_SELECTOR = "[data-composer-input]";

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

    /** Keep the fold card only while the pasted text is still in the draft. */
    function keepFoldFor(record, draft) {
      if (record === undefined || record === null) return false;
      if (typeof draft !== "string" || draft === "") return false;
      return draft.includes(record.text);
    }

    /**
     * Tiny session-keyed store shared between the paste listener and the dock
     * card. Hand-rolled so the bundle depends on nothing but react.
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

    /** Synthesize the File a spill paste becomes. */
    function spillFile(text, index) {
      return new File([text], pasteFileName(text, index), { type: "text/plain" });
    }

    /**
     * Start an upload for one synthesized paste file and watch it settle.
     * A file that never reaches `ready` leaves the submission stuck, so an
     * `error` restores the original text into the composer rather than losing it.
     *
     * @returns true when the attachment was admitted, false when the composer
     *   refused it (busy submit plane), in which case the caller keeps the text
     *   inline.
     */
    function uploadPaste({ conversation, sessionId, shell, text, index, onFailure }) {
      const file = spillFile(text, index);
      const drafts = conversation.createDrafts(sessionId, [file]);
      if (shell.addAttachments(drafts.map((draft) => draft.id)) === false) {
        conversation.releaseDraftAttachments(drafts);
        return false;
      }
      let settled = false;
      const stop = conversation.fileUploads.subscribe(() => {
        if (settled) return;
        const uploads = conversation.fileUploads.getSnapshot();
        for (const draft of drafts) {
          const status = uploads[draft.id];
          if (status === undefined) continue;
          if (status.status === "error") {
            settled = true;
            stop();
            onFailure();
            return;
          }
          if (status.status === "ready") {
            settled = true;
            stop();
            return;
          }
        }
      });
      return true;
    }

    /**
     * Testable core of the paste handler, with the DOM plumbing kept outside.
     * @returns "inline" | "fold" | "file" — what the handler decided to do.
     */
    function handlePasteEvent({ text, sessionId, conversation, shell, foldStore, preventDefault, index = 1 }) {
      const verdict = decidePaste(text);
      if (verdict.action === "inline") return "inline";
      if (verdict.action === "fold") {
        if (sessionId !== undefined) {
          foldStore.set(sessionId, { bytes: verdict.bytes, lines: countLines(text), text });
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
          text,
          index,
          onFailure: () => {
            try {
              shell.paste(text);
            } catch {
              /* restoring is best-effort; the failed attachment chip stays visible */
            }
          },
        });
      } catch {
        return "inline";
      }
      if (started === false) return "inline";
      preventDefault();
      return "file";
    }

    /**
     * The DOM-facing paste handler. Capture phase so it runs before the editor's
     * PASTE_COMMAND and can suppress the default insertion.
     */
    function onDocumentPaste(event, ctx, foldStore, nextIndex) {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (typeof Element !== "undefined" && target instanceof Element) {
        if (target.closest(COMPOSER_SELECTOR) === null) return;
      } else {
        return;
      }
      const clipboard = event.clipboardData;
      if (clipboard === null || clipboard === undefined) return;
      // A real file on the clipboard is stock's business, not ours.
      const items = [];
      for (let i = 0; i < clipboard.items.length; i += 1) items.push(clipboard.items[i]);
      if (items.some((item) => item.kind === "file")) return;
      const text = clipboard.getData("text/plain");
      if (typeof text !== "string" || text === "") return;
      const sessionId = ctx.sessions.list.getSnapshot().current;
      let shell;
      if (sessionId !== undefined) {
        try {
          shell = ctx.conversation.input.shell(sessionId);
        } catch {
          shell = undefined;
        }
      }
      handlePasteEvent({
        text,
        sessionId,
        conversation: ctx.conversation,
        shell,
        foldStore,
        index: nextIndex(),
        preventDefault: () => event.preventDefault(),
      });
    }

    /**
     * Dock card for the fold layer. It is a HINT, never a replacement: the full
     * text stays in the editor and is submitted verbatim, which is what keeps
     * slash-command and goal parsing identical to a plugin-free install.
     */
    function PasteFoldCard({ sessionId, usePasteFold, useDraft, t }) {
      const records = usePasteFold();
      const record = records === undefined || records === null ? undefined : records[sessionId];
      const draft = useDraft();
      if (!keepFoldFor(record, draft)) return null;
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

      if (ctx.locale !== undefined) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-paste-spill: dictionaries");
      }

      // Capture phase: runs before the editor's PASTE_COMMAND handler, which is
      // what makes preventDefault() able to suppress the default insertion.
      ctx.effect(() => {
        const listener = (event) => onDocumentPaste(event, ctx, foldStore, nextIndex);
        document.addEventListener("paste", listener, { capture: true });
        return () => document.removeEventListener("paste", listener, { capture: true });
      }, "dsh-paste-spill: paste listener");

      ctx.effect(() => {
        const selector = 'style[data-plugin-css="dsh-paste-spill"]';
        if (document.querySelector(selector) !== null) return () => {};
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-paste-spill";
        tag.dataset.pluginCss = "dsh-paste-spill";
        tag.textContent =
          ".dshps-fold-card{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance));" +
          "max-width:var(--dsh-composer-card-max-width);margin:0 auto;padding:6px 12px;border:.5px solid var(--dsw-alias-border-l1);" +
          "border-radius:12px;background:var(--dsw-specific-tip);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}" +
          ".dshps-fold-row{display:flex;align-items:center;gap:10px}" +
          ".dshps-fold-title{font-weight:500}" +
          ".dshps-fold-meta{color:var(--dsw-alias-label-tertiary)}" +
          ".dshps-fold-hint{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}";
        document.head.appendChild(tag);
        return () => tag.remove();
      }, "dsh-paste-spill: styles");

      ctx.slots.inject("conversation.composer.dock", () =>
        ctx.slots.register(
          {
            name: "conversation.composer.dock",
            id: "paste-spill",
            order: 0,
            locale: NS,
            inject: (sessionId) => {
              let shell = null;
              if (sessionId !== undefined) {
                try {
                  shell = ctx.conversation.input.shell(sessionId);
                } catch {
                  shell = null;
                }
              }
              return {
                sessionId,
                // The shell's `state` store carries the live draft; the card hides
                // itself as soon as the pasted text leaves the editor.
                useDraft: () => (shell === null ? "" : shell.state.getSnapshot().draft),
                hooks: { pasteFold: foldStore },
              };
            },
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
      keepFoldFor,
      createSessionStore,
      spillFile,
      uploadPaste,
      handlePasteEvent,
      onDocumentPaste,
      PasteFoldCard,
    };
    return module.exports;
  },
});
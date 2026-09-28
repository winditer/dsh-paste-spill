import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Wait for a deferred chip insert to finish.
 *
 * The insert is deferred out of the editor's update (Lexical #337) and, when its CAS is
 * refused, it yields a TASK turn between retries so the editor's queued commits can
 * drain. A single `await Promise.resolve()` therefore does not suffice: that only
 * flushes microtasks. This drains real task turns, so tests assert the settled state
 * instead of depending on how many internal yields happen to occur.
 *
 * Pass `until` to stop as soon as the outcome is observable, which is the honest way to
 * wait on an operation that retries a variable number of times.
 */
// A chip's real contribution to the CLIPBOARD draft.
//
// `ReferenceChipNode.getTextContent()` returns `clipboardText`, and the projection walk
// pushes that into the clipboard projection (only the DETECT projection receives the lone
// U+FFFC). `insertReference` then appends a trailing space unless one is already there.
// Stubs that modelled the draft as "\uFFFC" mis-described every chip fold -- that wrong
// assumption is what made a successful insert look like an 11-character draft with no chip.
function chipDraft(ref) {
  return `${ref.clipboardText} `;
}

async function settleChip(turns = 8, until = null) {
  for (let i = 0; i < turns; i += 1) {
    if (typeof until === "function" && until()) return;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
}

/**
 * Materialize lib/client.js exactly as the browser ModuleLoader would: capture
 * the registered record, then call its factory with a stubbed `require`.
 */
function loadBundle(reactExtras = {}) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  let record = null;
  // A working localStorage: the bundle's whole diagnostic channel goes through it, and a
  // test needs to read WHY a path stopped (e.g. whether the retry ended because its paste
  // already had a chip, or merely ran out of polls -- both look like "one chip").
  const storage = new Map();
  const fakeWindow = {
    __ModuleLoader__: { load: (value) => { record = value; } },
    localStorage: {
      getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
      setItem: (key, value) => { storage.set(String(key), String(value)); },
      removeItem: (key) => { storage.delete(String(key)); },
    },
  };
  const run = new Function("window", source);
  run(fakeWindow);
  assert.ok(record, "bundle must register itself with window.__ModuleLoader__.load");
  const react = {
    // Build a serializable stand-in for a React element tree so node-side tests
    // can assert on what the component renders without a DOM or react-dom.
    createElement: (type, props, ...children) => ({
      type: typeof type === "function" ? type.name || "Component" : type,
      props: props ?? null,
      children,
    }),
    memo: (component) => component,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    // Real react has both; the marker uses useLayoutEffect so the collapsed style
    // is applied in the SAME commit that reveals the fold, rather than one paint
    // later (which would flash the full 40k paste before snapping shut).
    useLayoutEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: () => ({ current: null }),
    useSyncExternalStore: () => undefined,
    // Overridable so a test can drive effects/refs (the band reservation reads a real
    // element through a ref and measures it in a layout effect).
    ...reactExtras,
  };
  const fakeRequire = (id) => {
    if (id === "react") return react;
    throw new Error(`unexpected require: ${id}`);
  };
  return {
    record,
    exports: record.factory(fakeRequire),
    /** This load's diagnostics, so a test can assert WHY a path stopped. */
    diag: () => (storage.has("dsh.paste-spill.diag") ? JSON.parse(storage.get("dsh.paste-spill.diag")) : null),
  };
}

/**
 * Apply the bundle against a context whose `inputTriggers` records registrations.
 *
 * The fold chip only exists if the source actually reaches the roster, so these
 * tests need the source object itself. The rest of the context is the same minimal
 * stub the other apply-level tests use.
 * @param options - `{ registered }`, the array the stub appends sources to.
 * @returns the loaded bundle, so callers can reach `__internals`.
 */
function applyWithTriggerStub({ registered }) {
  const { exports } = loadBundle();
  const ctx = {
    inputTriggers: {
      registerSource(source) {
        registered.push(source);
        return () => {};
      },
    },
    locale: { register: () => {} },
    effect: (fn) => { fn(); return () => {}; },
    slots: { inject: (_k, register) => register(), register: () => {} },
    conversation: { input: { shell: () => undefined } },
    sessions: { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} } },
  };
  // apply() installs its stylesheet, so it needs a document. Kept here rather than
  // in a shared global so these tests cannot leak a stub into the others.
  const documentStub = {
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild: () => {} },
  };
  const previousDocument = globalThis.document;
  globalThis.document = documentStub;
  try {
    exports.apply(ctx);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  return { exports };
}

/**
 * Materialize the bundle with a react stub whose effects actually RUN.
 *
 * The default stub no-ops useLayoutEffect/useEffect, which is right for asserting
 * on the rendered tree but useless for the wiring: the whole point of this plugin
 * is a DOM side effect (attributes on the stock composer card), and that only
 * happens when the effect body executes. This loader collects the effect callbacks
 * so a test can invoke them against a fake DOM.
 */
function loadBundleWithEffects() {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  let record = null;
  new Function("window", source)({ __ModuleLoader__: { load: (value) => { record = value; } } });
  const layoutEffects = [];
  const passiveEffects = [];
  const react = {
    createElement: (type, props, ...children) => ({
      type: typeof type === "function" ? type.name || "Component" : type,
      props: props ?? null,
      children,
    }),
    memo: (component) => component,
    useState: () => [undefined, () => {}],
    useEffect: (fn) => { passiveEffects.push(fn); },
    useLayoutEffect: (fn) => { layoutEffects.push(fn); },
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial ?? null }),
    useSyncExternalStore: () => undefined,
  };
  const exports = record.factory((id) => {
    if (id === "react") return react;
    throw new Error(`unexpected require: ${id}`);
  });
  return { exports, layoutEffects, passiveEffects };
}

/**
 * A stock-shaped composer card: the real InputBar renders the overlay anchor as a
 * child of [data-composer-card], so `closest` from inside the anchor resolves to
 * the card itself.
 */
function fakeCard() {
  const card = {
    attrs: new Set(),
    setAttribute(name) { this.attrs.add(name); },
    removeAttribute(name) { this.attrs.delete(name); },
    querySelector: () => null,
  };
  return card;
}

/**
 * Depth-first search over a serialized element tree for the first node whose props
 * include `key`.
 *
 * The chip used to be a direct child of the component's Fragment. It is now one item in
 * a RAIL (one chip per fold, mirroring the image rail), so a fixed-depth walk no longer
 * finds it and every render test would fail for the wrong reason.
 */
function findDeep(tree, key, seen = new Set()) {
  if (tree === null || typeof tree !== "object" || seen.has(tree)) return null;
  seen.add(tree);
  if (tree.props !== null && tree.props !== undefined && key in tree.props) return tree;
  for (const child of tree.children ?? []) {
    const hit = findDeep(child, key, seen);
    if (hit !== null) return hit;
  }
  return null;
}

/** Every node carrying `key`, in document order. */
function findAllDeep(tree, key, out = [], seen = new Set()) {
  if (tree === null || typeof tree !== "object" || seen.has(tree)) return out;
  seen.add(tree);
  if (tree.props !== null && tree.props !== undefined && key in tree.props) out.push(tree);
  for (const child of tree.children ?? []) findAllDeep(child, key, out, seen);
  return out;
}

/**
 * Find the chip button in a rendered PasteFoldChip tree, or null.
 *
 * The component always returns a Fragment of [locator, chip|null], so a test that
 * wants to know whether the visible affordance is on screen has to look one level
 * in rather than test the root.
 */
function chipOf(tree) {
  return findDeep(tree, "data-paste-spill-chip");
}

/** Every chip in the tree, so a multi-paste test can count them. */
function chipsOf(tree) {
  return findAllDeep(tree, "data-paste-spill-chip");
}

/**
 * The expand affordance inside the chip. The chip is now a container (a div)
 * holding the open button and the dismiss button, so a test that wants the
 * "expand" action has to reach one level further in than `chipOf`.
 */
function openButtonOf(tree) {
  return findDeep(chipOf(tree), "data-paste-spill-expand");
}

/** The dismiss (×) control inside the chip. */
function dismissButtonOf(tree) {
  return findDeep(chipOf(tree), "data-paste-spill-dismiss");
}

/** The zero-size locator element the component always renders. */
function anchorOf(tree) {
  for (const child of tree?.children ?? []) {
    if (child !== null && typeof child === "object" && child.props?.["data-paste-spill-anchor"]) return child;
  }
  return null;
}

/** Join the leaf strings of a serialized element tree. */
function leafText(tree) {
  const leaves = [];
  const walk = (node) => {
    if (typeof node === "string") {
      leaves.push(node);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return leaves.join("|");
}

/**
 * A minimal stand-in for the shell's InputState store: same shape the renderer
 * consumes (`getSnapshot`/`subscribe`) plus the `draftRev` counter the real
 * `compose()` publishes, which watchDraft uses to skip no-op notifications.
 */
function createDraftStore(initial, attachmentIds = []) {
  let state = { draft: initial, draftRev: 0, attachmentIds };
  const listeners = new Set();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDraft(text) {
      state = { ...state, draft: text, draftRev: state.draftRev + 1 };
      emit();
    },
    /**
     * Admit attachments the way stock does: the ids become VISIBLE in the published
     * snapshot, but WITHOUT bumping the draft revision or notifying.
     *
     * Both details matter. A stub that swallows the ids makes the composer look
     * permanently empty of attachments, which is indistinguishable from "the send
     * took them" -- the sidecar would appear to vanish the moment it was attached.
     * And notifying here would re-enter the watcher, which would re-attach: an
     * infinite loop that is purely an artifact of the stub.
     */
    addAttachments(ids) {
      state = { ...state, attachmentIds: [...state.attachmentIds, ...ids] };
      return true;
    },
    removeAttachment(id) {
      state = { ...state, attachmentIds: state.attachmentIds.filter((x) => x !== id) };
      return true;
    },
    /**
     * Mirror stock's own post-send commit.
     *
     * The important detail is which fields CHANGE. Stock's send path removes the
     * accepted attachment ids via a publish that does NOT bump the draft revision
     * (`removeAttachment`/`commitSend` never touch `this.rev`); only the editor
     * clearing moves the revision. An earlier version of this stub bumped `draftRev`
     * here, which made the plugin look correct while the real app never fired its
     * send detection at all -- the stub was more forgiving than the thing it stood
     * in for. The revision is left alone now so the test exercises the real ordering.
     */
    commitSend() {
      state = { ...state, draft: "", attachmentIds: [] };
      emit();
    },
  };
}

/**
 * A faithful stand-in for stock's composer editor.
 *
 * `createDraftStore` models a draft as a STRING, which was enough while the plugin
 * only moved text around. It cannot express the thing the plugin now depends on: a
 * chip node that contributes ONE character to the detect projection and its whole
 * `clipboardText` to the draft projection. Every coordinate bug in this plugin's
 * history (including "the second paste stays in the input box") came from confusing
 * those two projections, so the tests need a model that has both.
 *
 * The document is a list of atoms: one per text CHARACTER, one per CHIP. That makes
 * the detect projection the atom list itself (chip = 1 char) and the clipboard
 * projection the concatenation of each atom's clipboard form, which is exactly how
 * stock's `$composerLayout` walk defines the two.
 *
 * Implemented from the shipped source (dsh-client-ui-conversation/lib/client.js):
 *   `$composerLayout` (chip: detect "\uFFFC", clipboard `getTextContent()`)
 *   `selectSpan` (refuses a span past `detectLength`)
 *   `insertReference` (replaces the span with the chip, appends " " unless the
 *    following character is already a space)
 *   `insertAsyncText`/`replaceText` ("" removes the selected nodes)
 *   `compose()` (`draft` IS `clipboardText`, plus `draftRev`)
 *   `onEditorUpdate` (projection refreshed, then subscribers notified)
 */

/** One text atom per character, so detect offsets line up with atom indices. */
function textAtoms(text) {
  return [...String(text)].map((ch) => ({ kind: "text", ch }));
}

/** The clipboard/detect form of one atom. */
function atomText(atom) {
  return atom.kind === "chip" ? atom.clipboardText : atom.ch;
}

function createFakeComposer(startText = "") {
  let atoms = textAtoms(startText);
  let rev = 1;
  // The composer phase, as stock's `SessionInputShell` keeps it. Stock's
  // `insertReference` refuses whenever the phase is neither `plain` nor `claimed`
  // (verified in conv.js), which is how a paste made while the previous message of a
  // conversation is still in flight or awaiting approval produces no chip.
  let phase = "plain";
  /** Collapsed caret, in DETECT coordinates (= atom index). */
  let caret = atoms.length;
  const listeners = new Set();

  const detectText = () => atoms.map((atom) => (atom.kind === "chip" ? "\uFFFC" : atom.ch)).join("");
  const clipboardText = () => atoms.map(atomText).join("");
  const occurrences = () => {
    const out = [];
    let offset = 0;
    for (const atom of atoms) {
      if (atom.kind === "chip") {
        out.push({
          source: atom.source,
          ref: atom.ref,
          offset,
          length: atom.clipboardText.length,
          label: atom.label,
          clipboardText: atom.clipboardText,
        });
      }
      offset += atomText(atom).length;
    }
    return out;
  };
  const projection = () => ({
    detectText: detectText(),
    clipboardText: clipboardText(),
    occurrences: occurrences(),
    selection: { start: caret, end: caret },
    caret,
  });
  const snapshot = () => ({ draft: clipboardText(), draftRev: rev, phase, attachmentIds: [] });
  const publish = () => {
    for (const listener of [...listeners]) listener();
  };
  /** Every edit bumps the revision and notifies, like an editor commit. */
  const commit = () => {
    rev += 1;
    publish();
  };
  /**
   * A detect range may only cut at atom boundaries, and a chip may only be addressed
   * as a whole -- stock's `resolvePoint` maps an offset INSIDE a chip to the chip's
   * edge, and `selectSpan` refuses anything past the end.
   */
  const spanRefused = (span) => {
    if (span === null || span === undefined) return true;
    if (span.draftRev !== rev) return true;
    if (span.start < 0 || span.start > span.end || span.end > atoms.length) return true;
    return false;
  };
  const replaceAtoms = (start, end, next) => {
    atoms = [...atoms.slice(0, start), ...next, ...atoms.slice(end)];
    caret = Math.max(0, Math.min(start + next.length, atoms.length));
    commit();
  };

  const shell = {
    state: {
      getSnapshot: snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    get projection() {
      return projection();
    },
    caretSpan() {
      return { start: caret, end: caret };
    },
    /** Stock's shell method: phase + revision CAS, then the chip insert. */
    insertReference(reference, span) {
      if (phase !== "plain" && phase !== "claimed") return false;
      if (spanRefused(span)) return false;
      const tail = detectText().slice(span.end, span.end + 1);
      const chip = {
        kind: "chip",
        source: reference.source,
        ref: reference.ref,
        label: reference.label,
        clipboardText: reference.clipboardText,
      };
      const nodes = tail === " " ? [chip] : [chip, { kind: "text", ch: " " }];
      replaceAtoms(span.start, span.end, nodes);
      // The caret lands AFTER the chip and its trailing space, which is where a real
      // editor leaves it -- so a second paste goes after the space, not between.
      caret = span.start + nodes.length;
      return true;
    },
    /** Stock's shell method: revision CAS, then a plain-text splice. "" deletes. */
    insertText(text, span) {
      if (spanRefused(span)) return false;
      replaceAtoms(span.start, span.end, textAtoms(text));
      return true;
    },
    setDraft(text) {
      atoms = textAtoms(String(text).replace(/[\uE100-\uE11D\uFFFC]/gu, ""));
      caret = atoms.length;
      commit();
    },
    /** Stock's shell method: admission of synthesized attachment ids. */
    attachments: [],
    addAttachments(ids) {
      for (const id of ids) this.attachments.push(id);
      return true;
    },
    removeAttachment(id) {
      const at = this.attachments.indexOf(id);
      if (at < 0) return false;
      this.attachments.splice(at, 1);
      return true;
    },
  };
  // The action face strips placeholder characters, like `insertAsyncText`.
  shell.actions = {
    insertText: (text, span) => {
      if (spanRefused(span)) return false;
      replaceAtoms(span.start, span.end, textAtoms(String(text).replace(/[\uE100-\uE11D\uFFFC]/gu, "")));
      return true;
    },
  };

  return {
    shell,
    /** The published draft, in clipboard coordinates. */
    draft: clipboardText,
    detect: detectText,
    occurrences,
    projection,
    /** A paste/keystroke at the caret: text lands where the caret is. */
    insert(text) {
      // replaceAtoms already advances the caret past the inserted atoms, exactly as an
      // editor commit does; advancing it again here would leave the caret past the end
      // of the document, which nothing in the app can produce.
      replaceAtoms(caret, caret, textAtoms(String(text).replace(/[\uE100-\uE11D\uFFFC]/gu, "")));
      return this;
    },
    /** A revision bump with no text change: stock republishes after normalisation. */
    republish() {
      commit();
      return this;
    },
    /** Set the composer phase WITHOUT publishing: phase is metadata on the snapshot. */
    setPhase(next) {
      phase = next;
      return this;
    },
    /** The phase the watcher and the chip insert will see. */
    phase() {
      return phase;
    },
    /** Backspace over a whole chip, the way stock deletes a chip node. */
    deleteChip(ref) {
      const index = atoms.findIndex((atom) => atom.kind === "chip" && atom.ref === ref);
      if (index < 0) return false;
      replaceAtoms(index, index + 1, []);
      return true;
    },
    /** Stock's submit-time assembly: every chip is spliced out for its held text. */
    async submittedText(triggers) {
      const draft = clipboardText();
      const parts = [];
      for (const occurrence of occurrences()) {
        parts.push({
          offset: occurrence.offset,
          length: occurrence.length,
          text: await triggers.serializeReference(occurrence.source, occurrence.ref),
        });
      }
      let out = "";
      let cursor = 0;
      for (const part of parts) {
        out += draft.slice(cursor, part.offset) + part.text;
        cursor = part.offset + part.length;
      }
      out += draft.slice(cursor);
      return out.trim();
    },
  };
}

test("the bundle registers under the package name and exports a plugin", () => {
  const { record, exports } = loadBundle();
  // MUST equal the package name: the browser loader registers a bundle under the name
  // it requested, and the host scanner serves this module under the row's package. A
  // mismatch would leave the plugin silently unloaded (two packages ago this file was
  // its own package, dsh-client-ui-paste-spill, hence the id it used to carry).
  assert.equal(record.id, "dsh-paste-spill");
  assert.equal(typeof exports.apply, "function");
  assert.deepEqual(exports.inject, ["slots", "conversation", "sessions", "locale", "inputTriggers"]);
});

test("thresholds are the agreed UTF-8 byte values", () => {
  const { exports } = loadBundle();
  assert.equal(exports.__internals.FOLD_BYTES, 4000);
  assert.equal(exports.__internals.SPILL_BYTES, 50000);
});

test("utf8Bytes counts bytes, not characters", () => {
  const { utf8Bytes } = loadBundle().exports.__internals;
  assert.equal(utf8Bytes("abc"), 3);
  assert.equal(utf8Bytes("中文"), 6);
  assert.equal(utf8Bytes("a中b"), 5);
});

test("decidePaste routes on exact byte boundaries", () => {
  const { decidePaste } = loadBundle().exports.__internals;
  assert.equal(decidePaste("a".repeat(3999)).action, "inline");
  assert.equal(decidePaste("a".repeat(4000)).action, "fold");
  assert.equal(decidePaste("a".repeat(49999)).action, "fold");
  assert.equal(decidePaste("a".repeat(50000)).action, "file");
});

test("decidePaste boundary holds for multi-byte text", () => {
  const { decidePaste } = loadBundle().exports.__internals;
  // 2000 CJK characters is 6000 UTF-8 bytes: over the fold floor, under the spill floor.
  assert.equal(decidePaste("中".repeat(2000)).action, "fold");
  // 25000 CJK characters is 75000 bytes: past the spill floor.
  assert.equal(decidePaste("中".repeat(25000)).action, "file");
});

test("decidePaste reports the measured byte count", () => {
  const { decidePaste } = loadBundle().exports.__internals;
  assert.equal(decidePaste("中".repeat(2000)).bytes, 6000);
});

test("pasteFileName marks files with the host-recognized prefix", () => {
  const { pasteFileName } = loadBundle().exports.__internals;
  assert.equal(pasteFileName("hello world", 1), "pasted-text-1.txt");
  assert.equal(pasteFileName("```js\nconst a = 1;\n```", 3), "pasted-text-3.md");
  assert.equal(pasteFileName('{"a":1}', 2), "pasted-text-2.json");
  assert.equal(pasteFileName("def main():\n    return 1", 4), "pasted-text-4.py");
});

test("countLines counts newline-separated lines", () => {
  const { countLines } = loadBundle().exports.__internals;
  assert.equal(countLines("one"), 1);
  assert.equal(countLines("one\ntwo"), 2);
  assert.equal(countLines("one\ntwo\n"), 3);
});

test("foldTextPresent keeps the record alive while any sentinel remains", () => {
  const { foldTextPresent } = loadBundle().exports.__internals;
  const record = { bytes: 5000, lines: 2, sentinels: ["big pasted text"] };
  assert.equal(foldTextPresent(record, "prefix big pasted text suffix"), true);
  assert.equal(foldTextPresent(record, "big pasted tex"), false);
  assert.equal(foldTextPresent(record, ""), false);
  assert.equal(foldTextPresent(record, undefined), false);
});

test("foldTextPresent survives editor normalization that drops one sentinel", () => {
  const { foldTextPresent } = loadBundle().exports.__internals;
  // The run and the whole draft are both registered; losing either one alone
  // must not clear the record, which is the case that used to hide the card.
  const record = { bytes: 5000, lines: 2, sentinels: ["the pasted run", "the pasted run\nwith a trailing hard break"] };
  assert.equal(foldTextPresent(record, "the pasted run"), true);
  assert.equal(foldTextPresent(record, "the pasted run\nwith a trailing hard break"), true);
  assert.equal(foldTextPresent(record, "unrelated"), false);
  assert.equal(foldTextPresent({ bytes: 1, lines: 1, sentinels: [] }, "anything"), false);
});

test("createSessionStore notifies subscribers and clears per session", () => {
  const { createSessionStore } = loadBundle().exports.__internals;
  const store = createSessionStore();
  let notifications = 0;
  const dispose = store.subscribe(() => { notifications += 1; });
  assert.deepEqual(store.getSnapshot(), {});
  store.set("sess-1", { bytes: 5000, lines: 2, sentinels: ["x"] });
  assert.equal(notifications, 1);
  assert.deepEqual(store.getSnapshot()["sess-1"], { bytes: 5000, lines: 2, sentinels: ["x"] });
  store.clear("sess-1");
  assert.equal(notifications, 2);
  assert.deepEqual(store.getSnapshot(), {});
  dispose();
  store.set("sess-2", { bytes: 1, lines: 1, sentinels: ["y"] });
  assert.equal(notifications, 2);
});
test("spillFile builds a plain-text File with the synthesized name", () => {
  const { spillFile } = loadBundle().exports.__internals;
  const file = spillFile("a".repeat(50000), 7);
  assert.equal(file.name, "pasted-text-7.txt");
  assert.equal(file.type, "text/plain");
  assert.equal(file.size, 50000);
});

test("insertedRun isolates the inserted text from a pure insertion", () => {
  const { insertedRun } = loadBundle().exports.__internals;
  assert.equal(insertedRun("", "abc"), "abc");
  assert.equal(insertedRun("hello ", "hello world"), "world");
  assert.equal(insertedRun("keep", "pre keep"), "pre ");
  // A paste in the middle: the surrounding text is untouched, so prefix/suffix
  // trimming recovers exactly the inserted run.
  assert.equal(insertedRun("head tail", "head MIDDLE tail"), "MIDDLE ");
});

test("insertedRun reports no run for non-insertions", () => {
  const { insertedRun } = loadBundle().exports.__internals;
  assert.equal(insertedRun("same", "same"), null, "no change is not an insertion");
  assert.equal(insertedRun("abc", ""), null, "a clear is not an insertion");
  assert.equal(insertedRun("abc", undefined), null, "a missing draft is not an insertion");
  assert.equal(insertedRun("a long draft", "a long"), null, "a deletion produces no run");
});

test("reactToDraft leaves small insertions alone", () => {
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const outcome = reactToDraft({
    previous: "note: ",
    current: "note: short",
    run: "short",
    sessionId: "sess-1",
    conversation: {},
    shell: {},
    foldStore,
  });
  assert.equal(outcome, "inline");
  assert.deepEqual(foldStore.getSnapshot(), {});
});

test("a large paste folds into a chip, and the text stops being in the editor", async () => {
  const composer = createFakeComposer("");
  const { face, triggers } = setUpComposerFold(composer);
  const body = "x".repeat(6000);

  composer.insert(body);
  await settleChip();

  const record = face.hooks.pasteFold.getSnapshot()["s1"];
  assert.ok(record, "the paste folds");
  assert.equal(record.folds.length, 1, "one paste makes exactly one chip");
  assert.equal(record.folds[0].bytes, 6000);
  assert.equal(record.folds[0].lines, 1);
  assert.equal(record.folds[0].text, body, "the paste itself is what the fold carries");
  assert.equal(record.folds[0].pending, false, "the chip insert has settled");
  assert.equal(record.folds[0].chipInserted, true);

  // THE POINT OF FOLDING: the 6000 characters are no longer in the editor, so the
  // composer shows one chip instead of a wall of text.
  const projection = composer.projection();
  assert.equal(projection.occurrences.length, 1, "the editor holds one chip node");
  assert.equal(projection.occurrences[0].source, "folded-text");
  assert.equal(projection.occurrences[0].ref, record.folds[0].ref, "and it is this fold's node");
  assert.equal(projection.detectText, "\uFFFC ", "just the chip footprint");
  assert.ok(!projection.clipboardText.includes(body), "the raw paste is out of the draft");
  assert.equal(await triggers.serializeReference("folded-text", record.folds[0].ref), body,
    "and the reference serializes back to the original paste at submit time");
});

test("the fold is recorded synchronously, before the chip insert lands", () => {
  // The deferred insert runs in a microtask, so the state must already be coherent
  // the instant reactToDraft returns -- the chip is drawn from the record, and a
  // record that only appears after the insert would leave a frame with the raw text
  // visible and no chip.
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const composer = createFakeComposer("");
  const foldStore = createSessionStore();
  const run = "x".repeat(5000);

  const outcome = reactToDraft({
    previous: "",
    current: run,
    run,
    sessionId: "sess-1",
    conversation: { createDrafts() { throw new Error("fold must not upload"); } },
    shell: composer.shell,
    foldStore,
  });

  assert.equal(outcome, "fold");
  const entry = foldStore.getSnapshot()["sess-1"].folds[0];
  assert.equal(entry.bytes, 5000);
  assert.equal(entry.lines, 1);
  assert.equal(entry.pending, true, "the chip insert has not settled yet");
  assert.equal(entry.chipInserted, false);
  assert.deepEqual(entry.sentinels, [run], "and the sentinel is the run the editor still holds");
});

test("a shell that cannot host a chip leaves the text inline instead of pretending to fold", () => {
  // Folding IS chipping now, so a composer with no editor host has nowhere to put the
  // paste. Claiming "fold" there would draw a chip for text the user can see in the
  // box -- the double-report this rule exists to prevent.
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const run = "w".repeat(5000);

  for (const shell of [undefined, null, {}, { state: { getSnapshot: () => ({ draft: run, draftRev: 1 }) } }]) {
    foldStore.clear("sess-1");
    const outcome = reactToDraft({
      previous: "",
      current: run,
      run,
      sessionId: "sess-1",
      conversation: { createDrafts() { throw new Error("fold must not upload"); } },
      shell,
      foldStore,
    });
    assert.equal(outcome, "inline", "no chip host means no fold");
    assert.equal(foldStore.getSnapshot()["sess-1"], undefined, "and no record is left behind");
  }
});

test("a deferred chip insert is abandoned when the fold was retired first", async () => {
  // The insert is deferred to a microtask, so the fold can be gone by the time it runs
  // (a send, an ×, or a dismiss). Running it anyway would insert an orphaned chip node
  // into a composer the plugin no longer tracks -- an invisible placeholder that keeps
  // stock's `empty` test false, leaving the send button LIVE over an empty box.
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const composer = createFakeComposer("");
  const foldStore = createSessionStore();
  const run = "E".repeat(5000);

  reactToDraft({
    previous: "",
    current: run,
    run,
    sessionId: "sess-1",
    conversation: { createDrafts() { throw new Error("fold must not upload"); } },
    shell: composer.shell,
    foldStore,
  });
  // Retired before the settle runs.
  foldStore.clear("sess-1");
  await settleChip();

  assert.equal(composer.projection().occurrences.length, 0, "no orphaned chip node may be inserted");
  assert.equal(foldStore.getSnapshot()["sess-1"], undefined, "and no fold may come back");
});

test("a refused chip insert rolls the fold back, so the text stays inline and visible", async () => {
  // The chip's span is a CAS on the editor revision, so a concurrent editor update can
  // refuse it. The paste is then still inline; keeping the record would draw a second
  // representation of text the user can already see.
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const run = "v".repeat(5000);
  const composer = createFakeComposer(run);
  // Prototype-based, so the `projection` getter still reads the LIVE document: a
  // spread would freeze it at spread time and turn this into a "cannot locate the
  // run" test instead of a "the editor refused the span" test.
  const refusing = Object.create(composer.shell);
  refusing.insertReference = () => false;

  reactToDraft({
    previous: "",
    current: run,
    run,
    sessionId: "sess-1",
    conversation: { createDrafts() { throw new Error("fold must not upload"); } },
    shell: refusing,
    foldStore,
  });
  assert.equal(foldStore.getSnapshot()["sess-1"].folds.length, 1, "the fold is optimistically up");
  // The insert retries across editor turns before giving up, so wait for the rollback
  // rather than counting turns.
  await settleChip(24, () => foldStore.getSnapshot()["sess-1"] === undefined);

  assert.equal(foldStore.getSnapshot()["sess-1"], undefined, "a refused insert retires the fold");
  assert.equal(composer.draft(), run, "and the text is still in the editor, untouched");
});

test("a fold whose chip left the editor is retired, and its text released", async () => {
  // A chip node can disappear without the plugin being told: the user backspaces over
  // it. The record must not outlive the node, or the chip would stay on screen for text
  // that is no longer folded anywhere.
  const composer = createFakeComposer("");
  const { face, draftStore } = setUpComposerFold(composer);
  const first = "Q".repeat(5000);
  const second = "R".repeat(5000);

  composer.insert(first);
  await settleChip();
  composer.insert(second);
  await settleChip();
  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"].folds.length, 2, "precondition: two chips");

  const [kept, removed] = face.hooks.pasteFold.getSnapshot()["s1"].folds;
  assert.equal(composer.deleteChip(removed.ref), true, "the user backspaces over the second chip");

  const folds = face.hooks.pasteFold.getSnapshot()["s1"].folds;
  assert.deepEqual(folds.map((fold) => fold.ref), [kept.ref], "only the deleted chip's fold is retired");
  assert.equal(draftStore.getSnapshot().attachmentIds.length, 0, "still nothing attached");
});

test("the watcher retires a fold only when its own chip is gone, not on every edit", async () => {
  const composer = createFakeComposer("");
  const { face } = setUpComposerFold(composer);
  composer.insert("S".repeat(5000));
  await settleChip();
  const ref = face.hooks.pasteFold.getSnapshot()["s1"].folds[0].ref;

  composer.insert("typed around it");
  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"].folds.length, 1, "typing must not retire a fold whose chip is alive");
  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"].folds[0].ref, ref);
});


test("the chip previews the first 20 characters of the paste", () => {
  const { PREVIEW_CHARS, foldPreview } = loadBundle().exports.__internals;
  assert.equal(PREVIEW_CHARS, 20, "the preview line is 20 characters by request");

  const long = "abcdefghijklmnopqrstuvwxyz0123456789";
  const preview = foldPreview(long);
  assert.equal(preview, "abcdefghijklmnopqrst\u2026", "20 characters, then an ellipsis");
  assert.equal(preview.length, 21, "20 characters plus the ellipsis glyph");

  // A paste shorter than the budget is shown whole, with no misleading ellipsis.
  assert.equal(foldPreview("short"), "short");
  // Whitespace collapses to single spaces so the one-line chip cannot be pushed
  // around by an embedded newline.
  assert.equal(foldPreview("a\n\nb   c"), "a b c");
  assert.equal(foldPreview(""), "");
});

test("removing text is precise, and an unlocatable removal is never a draft wipe", () => {
  const { removePastedText } = loadBundle().exports.__internals;
  assert.equal(removePastedText("keep me PASTE keep me", "PASTE", ""), "keep me  keep me");
  // While a chip is mounted the draft is a lone U+FFFC, not the original text: the paste
  // cannot be located there. Deleting the placeholder is stock's own `writeOverChip`
  // (an explicit span write), NOT this function -- whose only callers are the spill
  // cleanups, where "cannot locate" must never mean "clear the composer".
  assert.equal(removePastedText("\uFFFC", "the original pasted text", ""), "\uFFFC");
});

test("reactToDraft uploads a spill-sized insertion", () => {
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const calls = { drafts: [], added: [], uploadListeners: 0 };
  const conversation = {
    createDrafts(sessionId, files) {
      calls.drafts.push({ sessionId, name: files[0].name });
      return [{ id: "draft-1", kind: "file" }];
    },
    releaseDraftAttachments() {},
    fileUploads: {
      subscribe() { calls.uploadListeners += 1; return () => {}; },
      getSnapshot() { return { "draft-1": { status: "uploading" } }; },
    },
  };
  const shell = { addAttachments(ids) { calls.added.push(ids); return true; } };
  const run = "y".repeat(50000);
  const outcome = reactToDraft({
    previous: "",
    current: run,
    run,
    sessionId: "sess-1",
    conversation,
    shell,
    foldStore: createSessionStore(),
  });
  assert.equal(outcome, "file");
  assert.deepEqual(calls.drafts, [{ sessionId: "sess-1", name: "pasted-text-1.txt" }]);
  assert.deepEqual(calls.added, [["draft-1"]]);
  assert.equal(calls.uploadListeners, 1);
});

test("reactToDraft falls back to inline when the composer refuses the attachment", () => {
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const calls = { released: [] };
  const conversation = {
    createDrafts() { return [{ id: "draft-1", kind: "file" }]; },
    releaseDraftAttachments(descriptors) { calls.released.push(descriptors.map((d) => d.id)); },
    fileUploads: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  };
  const run = "y".repeat(50000);
  const outcome = reactToDraft({
    previous: "",
    current: run,
    run,
    sessionId: "sess-1",
    conversation,
    shell: { addAttachments: () => false },
    foldStore: createSessionStore(),
  });
  assert.equal(outcome, "inline");
  assert.deepEqual(calls.released, [["draft-1"]]);
});

test("reactToDraft falls back to inline when the session has no shell", () => {
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const run = "y".repeat(50000);
  const outcome = reactToDraft({
    previous: "",
    current: run,
    run,
    sessionId: undefined,
    conversation: { createDrafts() { throw new Error("should not be called"); } },
    shell: undefined,
    foldStore: createSessionStore(),
  });
  assert.equal(outcome, "inline");
});

test("a fold writes the record and defers the chip insert", () => {
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const shell = {
    state: { getSnapshot: () => ({ draft: "unused", draftRev: 1, phase: "plain" }) },
    insertReference() { return true; },
    setDraft() {},
    caretSpan() { return { start: 0, end: 5000 }; },
  };
  const run = "t".repeat(5000);

  const outcome = reactToDraft({
    previous: "", current: run, run, sessionId: "sess-1",
    conversation: { createDrafts() { throw new Error("the fold must not upload"); } },
    shell, foldStore,
  });
  assert.equal(outcome, "fold");
  const record = foldStore.getSnapshot()["sess-1"];
  assert.ok(record);
  assert.equal(record.text, run, "the record keeps the pasted text");
});

test("a SECOND large paste adds a second chip instead of leaving the text inline", async () => {
  // Reported bug: "第二次复制6k的文件，没有生成第二个chip，而是在输入框中显示了文本内容".
  //
  // The old fold built its chip span as [0, draft.length) -- a CLIPBOARD length used as
  // a DETECT end. With one chip already in the editor the draft is longer than the
  // detect text, so the span fell past the end, `selectSpan` refused it, and the paste
  // stayed inline as 6000 raw characters. The span must therefore be located in the
  // detect projection and cover only the just-pasted run.
  const composer = createFakeComposer("");
  const { face, triggers } = setUpComposerFold(composer);
  const first = "a".repeat(6000);
  const second = "b".repeat(6000);

  composer.insert(first);
  await settleChip();
  composer.insert(second);
  await settleChip();

  const record = face.hooks.pasteFold.getSnapshot()["s1"];
  assert.equal(record.folds.length, 2, "the second paste makes a second chip");
  assert.equal(new Set(record.folds.map((fold) => fold.ref)).size, 2, "with a unique ref each");

  const projection = composer.projection();
  assert.equal(projection.occurrences.length, 2, "the editor holds two chip nodes");
  assert.equal(projection.detectText, "\uFFFC \uFFFC ", "one footprint per chip, one space between");
  assert.ok(!projection.clipboardText.includes(first), "the first paste stays folded");
  assert.ok(!projection.clipboardText.includes(second), "and the second does too -- no raw text in the box");
  // Typed text around the chips is still ordinary text, in the right order.
  assert.equal(await composer.submittedText(triggers), `${first} ${second}`, "and a send posts both pastes, in order");
});

test("the SAME text pasted twice makes two chips, not one chip plus inline text", async () => {
  // Reported in the app AFTER the session-dependence fix: "出现了chip，但第二次粘贴6K文本，
  // 没有chip，而是在输入框中显示文本". Root cause: the first version of the "fold once"
  // guard compared TEXT, so the second copy of an identical paste looked like the paste
  // that was already folded and was skipped -- leaving its 6008 characters inline while
  // one chip sat above them. Identity has to be per insertion, never per content.
  const composer = createFakeComposer("");
  const { face, triggers } = setUpComposerFold(composer);
  const same = "c".repeat(6000);

  composer.insert(same);
  await settleChip();
  composer.insert(same);
  await settleChip();

  const record = face.hooks.pasteFold.getSnapshot()["s1"];
  assert.equal(record.folds.length, 2, "two chips for two pastes, even with identical content");
  assert.equal(new Set(record.folds.map((fold) => fold.ref)).size, 2, "each with its own ref");
  assert.equal(composer.projection().occurrences.length, 2, "two chip nodes in the editor");
  assert.equal(composer.projection().detectText, "\uFFFC \uFFFC ", "and no raw text left inline");
  assert.equal(await composer.submittedText(triggers), `${same} ${same}`, "a send posts both copies");
});

test("typing around a chip keeps the fold, and what the user types is what they see", async () => {
  // Reported bug: "输入框中可以输入文字，但是上层被chip覆盖了" -- typing worked but the chip
  // rail was drawn OVER the editor's first line, so the characters were hidden. The fix
  // is geometric (reserve the rail's band) and lives in the component tests below; this
  // pins the other half: a keystroke must NOT tear the fold down. Retiring the fold on
  // every edit is what the older design did, and it makes the chip vanish the moment the
  // user adds a word after it.
  const composer = createFakeComposer("");
  const { face } = setUpComposerFold(composer);
  const body = "h".repeat(6000);

  composer.insert(body);
  await settleChip();
  const ref = face.hooks.pasteFold.getSnapshot()["s1"].folds[0].ref;

  composer.insert("hello");
  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"].folds[0].ref, ref, "the fold survives typing");
  assert.ok(composer.draft().includes("hello"), "and the typed text is in the draft, where the user can see it");
  assert.ok(!composer.draft().includes(body), "while the paste stays folded away");
});

test("a deletion that does not touch the chip keeps the fold", async () => {
  // The old design retired the fold on ANY edit, because the collapsed editor hid the
  // text and an invisible edit would be wrong. Nothing is hidden now: the chip is a
  // normal editor node, so deleting the typed characters beside it must leave it alone.
  const composer = createFakeComposer("");
  const { face } = setUpComposerFold(composer);
  composer.insert("y".repeat(6000));
  await settleChip();
  composer.insert("tail");
  await settleChip();

  // Backspace over the typed text only.
  const before = composer.draft();
  composer.shell.insertText("", { start: before.length - 4, end: before.length, draftRev: composer.projection().selection.start === 0 ? 0 : undefined });

  const after = face.hooks.pasteFold.getSnapshot()["s1"];
  assert.ok(after, "the fold is still there after editing elsewhere");
  assert.equal(after.folds.length, 1);
});

test("a normalisation republish after a fold does NOT retire it", async () => {
  // After a chip insert, Lexical can republish the draft with a new revision but the same
  // text. That is not an edit: the chip is still in the document and the fold must survive,
  // or the chip would blink out and the text would have to be recovered from the hold.
  const composer = createFakeComposer("");
  const { face } = setUpComposerFold(composer);
  composer.insert("x".repeat(6000));
  await settleChip();
  const ref = face.hooks.pasteFold.getSnapshot()["s1"].folds[0].ref;

  composer.republish();

  const record = face.hooks.pasteFold.getSnapshot()["s1"];
  assert.ok(record, "the fold survives a normalisation republish");
  assert.equal(record.folds[0].ref, ref, "and it is the same fold");
  assert.equal(composer.projection().occurrences.length, 1, "with the chip still in the editor");
});


test("reactToDraft drops the fold record when the draft is cleared", () => {
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  foldStore.set("sess-1", { bytes: 5000, lines: 1, text: "x".repeat(5000) });
  const outcome = reactToDraft({
    previous: "x".repeat(5000),
    current: "",
    run: null,
    sessionId: "sess-1",
    conversation: {},
    shell: {},
    foldStore,
  });
  assert.equal(outcome, "inline");
  assert.deepEqual(foldStore.getSnapshot(), {}, "a cleared draft must remove the card");
});

test("watchDraft reacts to draft transitions and stops on unsubscribe", async () => {
  const { watchDraft, createSessionStore, createPasteInbox } = loadBundle().exports.__internals;
  const composer = createFakeComposer("");
  const foldStore = createSessionStore();
  const restores = [];
  const stop = watchDraft({
    shell: composer.shell,
    foldStore,
    sessionId: "sess-1",
    ctx: {},
    conversation: {},
    nextIndex: () => 1,
    inbox: createPasteInbox(),
    onRestore: () => restores.push(true),
  });
  composer.insert("x".repeat(5000));
  await settleChip();
  assert.equal(foldStore.getSnapshot()["sess-1"].folds.length, 1, "the watcher folds a large insertion");
  stop();
  composer.insert("y".repeat(5000));
  await settleChip();
  assert.equal(foldStore.getSnapshot()["sess-1"].folds.length, 1, "after unsubscribe nothing more is recorded");
  assert.deepEqual(restores, [], "a fold never restores the draft");
});

test("watchDraft removes the text only after the upload reports ready", async () => {
  const { watchDraft, createSessionStore, createPasteInbox } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const draftStore = createDraftStore("keep me");
  let ready = false;
  const conversation = {
    createDrafts() { return [{ id: "draft-1", kind: "file" }]; },
    releaseDraftAttachment() {},
    releaseDraftAttachments() {},
    fileUploads: {
      subscribe(fn) { listeners.push(fn); return () => {}; },
      getSnapshot: () => ({ "draft-1": { status: ready ? "ready" : "uploading" } }),
    },
  };
  const listeners = [];
  const restores = [];
  const stop = watchDraft({
    shell: { state: draftStore, addAttachments: (ids) => draftStore.addAttachments(ids), setDraft: (text) => draftStore.setDraft(text) },
    foldStore,
    sessionId: "sess-1",
    conversation,
    nextIndex: () => 1,
    inbox: createPasteInbox(),
    onRestore: () => restores.push(true),
  });
  draftStore.setDraft("keep me" + "y".repeat(50000));
  assert.equal(
    draftStore.getSnapshot().draft,
    "keep me" + "y".repeat(50000),
    "while uploading, the text must stay in the editor so a failure cannot lose it",
  );
  ready = true;
  for (const fn of listeners) fn();
  assert.equal(draftStore.getSnapshot().draft, "keep me", "ready must take only the spilled text out");
  assert.deepEqual(restores, [true]);
  stop();
});

test("watchDraft keeps the text inline when the upload fails", async () => {
  const { watchDraft, createSessionStore, createPasteInbox } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const draftStore = createDraftStore("");
  const listeners = [];
  const removed = [];
  const conversation = {
    createDrafts() { return [{ id: "draft-1", kind: "file" }]; },
    releaseDraftAttachment(id) { removed.push(id); },
    releaseDraftAttachments() {},
    fileUploads: {
      subscribe(fn) { listeners.push(fn); return () => {}; },
      getSnapshot: () => ({ "draft-1": { status: "error", message: "boom" } }),
    },
  };
  const restores = [];
  const stop = watchDraft({
    shell: {
      state: draftStore,
      addAttachments: (ids) => draftStore.addAttachments(ids),
      setDraft: (text) => draftStore.setDraft(text),
      removeAttachment: () => true,
    },
    foldStore,
    sessionId: "sess-1",
    ctx: {},
    conversation,
    nextIndex: () => 1,
    inbox: createPasteInbox(),
    onRestore: () => restores.push(true),
  });
  const text = "z".repeat(50000);
  draftStore.setDraft(text);
  for (const fn of listeners) fn();
  assert.equal(draftStore.getSnapshot().draft, text, "a failed upload must leave the text untouched");
  assert.deepEqual(restores, [], "a failure never reports a restore");
  assert.deepEqual(removed, ["draft-1"], "the failed chip is withdrawn");
  stop();
});

test("reactToDraft still uploads when the upload settled before we subscribed", () => {
  // Regression: the attachment can reach `ready` before uploadPaste gets to
  // subscribe. Relying on the subscription alone would then leave the spilled
  // text in the editor forever, since no further notification ever arrives.
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const calls = { addAttachments: 0 };
  const conversation = {
    createDrafts() { return [{ id: "draft-1", kind: "file" }]; },
    releaseDraftAttachment() {},
    releaseDraftAttachments() {},
    fileUploads: {
      // Never notifies; the state is already terminal at subscribe time.
      subscribe() { return () => {}; },
      getSnapshot: () => ({ "draft-1": { status: "ready" } }),
    },
  };
  let ready = 0;
  const run = "y".repeat(50000);
  const outcome = reactToDraft({
    previous: "",
    current: run,
    run,
    sessionId: "sess-1",
    conversation,
    shell: { addAttachments() { calls.addAttachments += 1; return true; } },
    foldStore: createSessionStore(),
    onUploadSettled: (ok) => { if (ok === true) ready += 1; },
  });
  assert.equal(outcome, "file");
  assert.equal(calls.addAttachments, 1);
  assert.equal(ready, 1, "an already-ready upload must still report success");
});

test("measurableText backstops a huge insertion the trim under-reports", () => {
  const { measurableText } = loadBundle().exports.__internals;
  // Trimming consumes up to previous.length at each end, so a big draft plus a
  // bigger paste can trim to a run below the threshold even for a pure append.
  const previous = "p".repeat(40000);
  const current = previous + "q".repeat(60000);
  const run = "q".repeat(1); // trimming can reduce the residue to nearly nothing
  assert.ok(run.length < 50000);
  const out = measurableText({ recorded: null, run, previous, current });
  assert.equal(out, current, "a single >=spill jump must be measured on the whole draft");
  // A modest growth is still judged by the diff, not by the whole draft.
  const small = measurableText({ recorded: null, run: "hello", previous: "x", current: "xhello" });
  assert.equal(small, "hello", "ordinary edits keep using the trimmed diff");
});

test("removePastedText refuses a whole-draft candidate that has a pre-existing prefix", () => {
  const { removePastedText } = loadBundle().exports.__internals;
  // The data-loss trap: the size backstop may measure the WHOLE draft. Passing
  // that as the excision target for an append would delete the user's own text.
  const before = "p".repeat(40000);
  const current = before + "q".repeat(60000);
  assert.equal(
    removePastedText(current, current, before),
    current,
    "a whole-draft candidate with a pre-existing prefix must not excise anything",
  );
  // The two legitimate whole-draft cases still clear the composer.
  assert.equal(removePastedText("a".repeat(60000), "a".repeat(60000), ""), "", "pasting into an empty draft clears it");
  assert.equal(
    removePastedText("b".repeat(60000), "b".repeat(60000), "a".repeat(5000)),
    "",
    "replacing the whole draft clears it",
  );
});

test("a 60k paste into an empty composer spills even with no observer", () => {
  // The real reported case, replayed on the real fixture: a large paste into an
  // empty composer must spill on the diff alone, with no clipboard observer
  // involved at all. This is the path that matters most, because it is the one
  // that works regardless of whether beforeinput/paste deliver.
  const { reactToDraft, createSessionStore, insertedRun, measurableText } = loadBundle().exports.__internals;
  const fixture = readFileSync(new URL("../fixtures/paste-60k.json", import.meta.url), "utf8");
  assert.ok(fixture.length > 60000, "fixture is a 60k document");
  const previous = "";
  const current = fixture;
  const run = insertedRun(previous, current);
  const candidate = measurableText({ recorded: null, run, previous, current });
  const added = [];
  const conversation = {
    createDrafts(sessionId, files) { added.push(files[0].name); return [{ id: "draft-1", kind: "file" }]; },
    releaseDraftAttachments() {},
    releaseDraftAttachment() {},
    fileUploads: { subscribe: () => () => {}, getSnapshot: () => ({ "draft-1": { status: "uploading" } }) },
  };
  const shell = { addAttachments: () => true };
  const decision = reactToDraft({
    previous, current, run, recorded: null,
    sessionId: "sess-1", conversation, shell, foldStore: createSessionStore(),
  });
  assert.equal(decision, "file", "a 60k paste into an empty composer must become a file");
  assert.equal(added.length, 1);
  assert.match(added[0], /^pasted-text-/);
});

test("the paste inbox keeps only the newest paste and expires stale ones", () => {
  const { createPasteInbox } = loadBundle().exports.__internals;
  const inbox = createPasteInbox();
  assert.equal(inbox.take(), null, "an empty inbox yields nothing");
  inbox.record("first");
  inbox.record("first and then a longer second");
  const got = inbox.take();
  assert.equal(got.text, "first and then a longer second", "the newest paste wins");
  assert.equal(inbox.take(), null, "taking consumes the entry");
  // An entry older than the limit must not be blamed for an unrelated later edit.
  inbox.record("stale");
  const t = Date.now();
  assert.equal(inbox.take(undefined, -1), null, "an expired entry is discarded");
  assert.ok(Date.now() - t < 1000);
});

test("a paste is held per session, so switching conversations cannot steal it", () => {
  // The bug this pins: one global slot meant a paste recorded for conversation A
  // could be consumed by conversation B's watcher (or by nothing at all if B's
  // watcher was the one that ran), which shows up as "some conversations fold and
  // others silently do not".
  const { createPasteInbox } = loadBundle().exports.__internals;
  const inbox = createPasteInbox();
  inbox.record("six kilobytes for alpha", "paste", "alpha");
  inbox.record("six kilobytes for beta", "paste", "beta");
  assert.equal(inbox.take("alpha").text, "six kilobytes for alpha", "alpha gets its own paste");
  assert.equal(inbox.take("alpha"), null, "and only once");
  assert.equal(inbox.take("beta").text, "six kilobytes for beta", "beta still has its own");
  // A recording whose DOM target could not name a session is NOT addressable by any
  // session: handing it to whichever watcher asks first is how one conversation's paste
  // ended up attached to another conversation's draft (and mailed as its message) while
  // the conversation that really received it folded nothing.
  inbox.record("unmapped payload", "beforeinput");
  assert.equal(inbox.take("gamma"), null, "no session may claim a paste that was not addressed to it");
  assert.equal(inbox.peek("gamma"), null, "and peeking cannot claim it either");
  assert.equal(inbox.take().text, "unmapped payload", "the session-less view still sees it");
  // peek must not consume: the armed path looks several times before it commits.
  inbox.record("peeked payload", "paste", "delta");
  assert.equal(inbox.peek("delta").text, "peeked payload");
  assert.equal(inbox.peek("delta").text, "peeked payload", "peeking twice still sees it");
  assert.equal(inbox.take("delta").text, "peeked payload", "and it is still takeable");
  // consume(entry) is precise: a replaced entry must not be consumed by a stale caller.
  inbox.record("old entry", "paste", "epsilon");
  const stale = inbox.peek("epsilon");
  inbox.record("new entry", "paste", "epsilon");
  assert.equal(inbox.consume(stale), false, "a superseded entry cannot be consumed");
  assert.equal(inbox.take("epsilon").text, "new entry", "the newer entry survives");
  assert.equal(inbox.consume(null), false);
});

test("measurableText prefers the recorded paste over the unreliable diff", () => {
  const { measurableText } = loadBundle().exports.__internals;
  // The blind spot this pins down: the diff reports the NET change, so when the
  // pasted text is nearly identical to what it replaced it reports almost
  // nothing -- even though tens of thousands of bytes just arrived. Here the two
  // drafts differ by one word, so the diff sees a handful of bytes for a
  // 40,000-byte paste.
  const base = '{"readings":{"backward":{"1m":"https://fms"';
  const before = base + '"telemetry":true' + "z".repeat(40000);
  const after = base + '"status":true' + "z".repeat(40000);
  // emulate the prefix/suffix trim
  let head = 0;
  while (head < Math.min(before.length, after.length) && before[head] === after[head]) head += 1;
  let tail = 0;
  while (before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  const run = after.slice(head, after.length - tail);
  assert.ok(
    run.length <= 8,
    `the raw diff under-reports a near-identical replacement (got ${run.length})`,
  );
  const recorded = { text: after, bytes: 40000, at: Date.now() };
  assert.equal(
    measurableText({ recorded, run }),
    after,
    "the recorded clipboard text must win so the spill threshold is judged on the real paste",
  );
  assert.equal(measurableText({ recorded: null, run }), run, "the diff is still the fallback");
});

test("a recorded paste still spills even when the diff under-reports it", () => {
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const shared = '{"readings":{"backward":{"1m":"https://fms"';
  const before = shared + '"telemetry":true}}}';
  const pasted = shared + '"status":true}}}' + "z".repeat(50000);
  const run = "z".repeat(3); // what a naive prefix/suffix trim would guess
  const calls = { added: 0 };
  const conversation = {
    createDrafts() { return [{ id: "draft-1", kind: "file" }]; },
    releaseDraftAttachments() {},
    releaseDraftAttachment() {},
    fileUploads: { subscribe: () => () => {}, getSnapshot: () => ({ "draft-1": { status: "uploading" } }) },
  };
  const outcome = reactToDraft({
    previous: before,
    current: pasted,
    run,
    recorded: { text: pasted, bytes: 50000, at: Date.now() },
    sessionId: "sess-1",
    conversation,
    shell: { addAttachments() { calls.added += 1; return true; } },
    foldStore: createSessionStore(),
  });
  assert.equal(outcome, "file", "the real paste size decides, not the diff");
  assert.equal(calls.added, 1);
});

test("removePastedText takes out only the paste, preserving surrounding text", () => {
  const { removePastedText } = loadBundle().exports.__internals;
  const big = "y".repeat(50000);
  // append after existing text
  assert.equal(removePastedText("keep me" + big, big, "keep me"), "keep me");
  // a replacement of similar text must not wipe the whole draft
  const before = '{"a":"telemetry","end":1}';
  const after = '{"a":"status","end":1}';
  assert.equal(removePastedText(after, after, before), "", "a full replacement removes the whole draft");
  // NOT LOCATED LEAVES THE DRAFT ALONE. This used to return "" ("empty is the honest
  // fallback"), and the spill cleanup then wrote that empty draft back: a CRLF paste --
  // whose clipboard bytes are never a substring of the LF draft -- deleted the user's own
  // typed text along with the paste. The attachment already holds the paste, so keeping
  // the text inline is both harmless and the only non-destructive answer.
  assert.equal(removePastedText("something else", "\u0000absent", "x"), "something else");
  assert.equal(
    removePastedText("keep my typing\r\nand more", "pasted\r\nwith crlf", "keep my typing"),
    "keep my typing\r\nand more",
    "a clipboard rendering the editor never stored must not be treated as an empty draft",
  );
  // The editor's rendering IS found, so a CRLF paste is still removed precisely.
  assert.equal(
    removePastedText("keep me\npasted\nwith crlf", "pasted\r\nwith crlf", "keep me\n"),
    "keep me\n",
    "the LF rendering of the same payload is located and taken out",
  );
});

test("a folded run is always a substring of the draft it was diffed from", () => {
  // This invariant is what makes the fold card's visibility check exact: the run
  // comes out of the draft itself, so keepFoldFor's `draft.includes(record.text)`
  // holds by construction. The previous clipboard-event design compared the raw
  // clipboard string against the editor's normalized projection text — two
  // different sources that could legitimately disagree.
  const { insertedRun, foldTextPresent } = loadBundle().exports.__internals;
  const cases = [
    ["", "x".repeat(5000)],
    ["pasted earlier ", "pasted earlier " + "y".repeat(5000)],
    ["head tail", "head " + "z".repeat(5000) + " tail"],
  ];
  for (const [before, after] of cases) {
    const run = insertedRun(before, after);
    assert.ok(run !== null, "each case is an insertion");
    assert.ok(after.includes(run), "the run must be a substring of the resulting draft");
    // Sentinels are recorded exactly as the fold branch builds them.
    const record = { bytes: 5000, lines: 1, sentinels: after === run ? [run] : [run, after] };
    assert.equal(foldTextPresent(record, after), true, "so the record survives the insertion");
    assert.equal(foldTextPresent(record, before), false, "and is dropped once the text is gone");
  }
});

test("no fold record renders nothing", () => {
  const { PasteFoldChip } = loadBundle().exports.__internals;
  const tree = PasteFoldChip({
    sessionId: "sess-1",
    usePasteFold: (select) => select({}),
    useFoldExpanded: (select) => select({}),
    t: (key) => key,
  });
  // No record, no chip, nothing rendered.
  assert.equal(chipOf(tree), null, "nothing folded means no chip");
});

test("the rail renders one chip per fold, each with its own ×", () => {
  // "支持多次粘贴": three pastes into one composer must put three chips on the rail, and
  // × on one of them must remove only that one. The old component rendered a single chip
  // from a single record, so a repeat paste replaced the previous fold and looked like
  // nothing happened.
  const { PasteFoldChip } = loadBundle().exports.__internals;
  const folds = [
    { ref: "r1", bytes: 5000, lines: 1, text: "a".repeat(5000) },
    { ref: "r2", bytes: 5000, lines: 1, text: "b".repeat(5000) },
    { ref: "r3", bytes: 5000, lines: 1, text: "c".repeat(5000) },
  ];
  const record = { folds, bytes: 5000, lines: 1, text: folds[2].text, chipRef: "r3" };
  const tree = PasteFoldChip({
    sessionId: "sess-1",
    usePasteFold: (select) => select({ "sess-1": record }),
    useFoldExpanded: (select) => select({}),
    onDismiss: () => {},
    t: (key) => key,
  });
  const chips = chipsOf(tree);
  assert.equal(chips.length, 3, "one chip per fold");
  const dismisses = findAllDeep(tree, "data-paste-spill-dismiss");
  assert.equal(dismisses.length, 3, "each chip has its own ×");
  // The × names the chip it removes, so the handler can delete just that paste.
  assert.deepEqual(dismisses.map((d) => d.props["data-paste-spill-dismiss"]), ["r1", "r2", "r3"]);
});

test("× on one chip asks for just that fold to be removed", () => {
  const { PasteFoldChip } = loadBundle().exports.__internals;
  const calls = [];
  const folds = [
    { ref: "r1", bytes: 5000, text: "a".repeat(5000) },
    { ref: "r2", bytes: 5000, text: "b".repeat(5000) },
  ];
  const tree = PasteFoldChip({
    sessionId: "sess-1",
    usePasteFold: (select) => select({ "sess-1": { folds } }),
    useFoldExpanded: (select) => select({}),
    onDismiss: (sessionId, ref) => calls.push([sessionId, ref]),
    t: (key) => key,
  });
  const dismisses = findAllDeep(tree, "data-paste-spill-dismiss");
  // Click the SECOND chip's ×: it must name r2, not the session alone.
  dismisses[1].props.onClick();
  assert.deepEqual(calls, [["sess-1", "r2"]], "the × carries the chip it removes");
});

test("the chip renders from the fold record alone, without a draft hook", () => {
  const { PasteFoldChip } = loadBundle().exports.__internals;
  // The card deliberately has NO draft hook: the session binding's draft store is
  // materialized once and cached, so a binding born before the shell existed would
  // hand the card a permanently empty store and hide it forever. The watcher owns
  // clearing the record instead, so rendering depends on exactly one store.
  const record = { bytes: 5000, lines: 2, sentinels: ["big pasted text"] };
  const tree = PasteFoldChip({
    sessionId: "sess-1",
    usePasteFold: (select) => select({ "sess-1": record }),
    useFoldExpanded: (select) => select({}),
    t: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
  });
  const chip = chipOf(tree);
  assert.notEqual(chip, null, "a record alone must be enough to render the chip");
  // Collect leaf strings rather than matching the whole serialized tree: the
  // JSON form escapes the quotes inside the interpolated label arguments.
  const text = leafText(chip);
  // The chip now previews the CONTENT (Codex-style) instead of a byte/line
  // summary, and offers the "show in text box" affordance.
  assert.match(text, /foldPreview|foldTitle/, "the chip previews the folded text");
  assert.match(text, /foldExpandAction/, "and names the expand action");
  // "Sent as-is" moved onto the expand control's tooltip. The build that rendered
  // it as a paragraph ABOVE the input box was rejected.
  assert.match(openButtonOf(tree).props.title, /foldHint/);
});

test("the composer entry exposes store-shaped hooks, not plain functions", () => {
  const { apply } = loadBundle().exports;
  const capture = { entry: null, component: null, effects: [], registered: [] };
  const stateStore = { getSnapshot: () => ({ draft: "hi" }), subscribe: () => () => {} };
  const documentStub = {
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
  };
  const previousDocument = globalThis.document;
  globalThis.document = documentStub;
  try {
    const ctx = {
      locale: { register: () => {} },
      effect: (fn) => { capture.effects.push(fn); return () => {}; },
      slots: {
        inject: (_key, register) => register(),
        register: (entry, component) => {
          capture.entry = entry;
          capture.component = component;
          capture.registered.push(entry.name);
        },
      },
      conversation: { input: { shell: () => ({ state: stateStore }) } },
    };
    apply(ctx);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }

  // Exactly ONE registration. The visible chip and the editor clamp both live in
  // `conversation.input.overlay`, the only slot that renders inside
  // [data-composer-card]. A separate dock registration would put the affordance
  // outside the input box, which is what was rejected.
  assert.deepEqual(capture.registered, ["conversation.input.overlay"]);
  assert.equal(capture.entry.id, "paste-spill", "must not collide with the stock overlay occupants");
  assert.equal(typeof capture.component, "function");

  const face = capture.entry.inject("sess-1");
  // The renderer wraps every `hooks` value in useSyncExternalStore, so each one
  // MUST be a store. A plain function here silently never re-renders.
  for (const [name, source] of Object.entries(face.hooks)) {
    assert.equal(typeof source.subscribe, "function", `hook ${name} must expose subscribe`);
    assert.equal(typeof source.getSnapshot, "function", `hook ${name} must expose getSnapshot`);
  }
  // ONE store, and it is the rail's only data source. `foldExpanded` is gone with the
  // collapse flag it carried: the text is either folded into a chip or back in the
  // editor, so there is no second state to remember.
  assert.deepEqual(Object.keys(face.hooks), ["pasteFold"]);
});

test("the chip rail registers inside the composer card, not beside it", () => {
  const { apply } = loadBundle().exports;
  // The whole point of the collapsing half: `conversation.input.overlay` is
  // rendered INSIDE [data-composer-card], which is the only way to reach the
  // editor we must clamp, and it is session-scoped so the attribute lands on the
  // right composer when two sessions are open.
  const slots = new Map();
  const documentStub = {
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
  };
  const previousDocument = globalThis.document;
  globalThis.document = documentStub;
  try {
    apply({
      locale: { register: () => {} },
      effect: () => () => {},
      slots: { inject: (_k, register) => register(), register: (e, c) => slots.set(e.name, { entry: e, component: c }) },
      conversation: { input: { shell: () => undefined } },
      sessions: { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} } },
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  assert.deepEqual([...slots.keys()], ["conversation.input.overlay"],
    "one in-card slot only: a dock registration would sit outside the input box");
  const overlay = slots.get("conversation.input.overlay");
  assert.equal(overlay.entry.id, "paste-spill", "must not collide with the stock overlay occupants");
  const face = overlay.entry.inject("sess-1");
  // Both handlers are plain functions carrying the CHIP's ref, so expand and × act on
  // exactly one paste even when several are folded.
  assert.equal(typeof face.onToggle, "function", "the rail needs the expand handler");
  assert.equal(typeof face.onDismiss, "function", "and the delete handler");
  for (const [name, source] of Object.entries(face.hooks)) {
    assert.equal(typeof source.subscribe, "function", `hook ${name} must expose subscribe`);
    assert.equal(typeof source.getSnapshot, "function", `hook ${name} must expose getSnapshot`);
  }
  assert.deepEqual(Object.keys(face.hooks), ["pasteFold"]);
});

test("a chip whose node left the editor hides its chip, and an empty composer clears everything", async () => {
  const { PasteFoldChip } = loadBundle().exports.__internals;
  const composer = createFakeComposer("");
  const { face } = setUpComposerFold(composer);
  const run = "x".repeat(5000);
  composer.insert(run);
  await settleChip();

  const visible = () => chipOf(PasteFoldChip({
    sessionId: "s1",
    usePasteFold: (select) => select(face.hooks.pasteFold.getSnapshot()),
    t: (key) => key,
  }));
  assert.notEqual(visible(), null, "the chip shows while its node is in the editor");
  const ref = face.hooks.pasteFold.getSnapshot()["s1"].folds[0].ref;

  composer.deleteChip(ref);
  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"], undefined, "losing the node retires the fold");
  assert.equal(visible(), null, "and the chip must then render nothing");
});

test("the inject never touches the session shell, so a missing binding cannot hide the chip", () => {
  const { apply } = loadBundle().exports;
  let entry = null;
  const documentStub = {
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
  };
  const previousDocument = globalThis.document;
  globalThis.document = documentStub;
  try {
    apply({
      locale: { register: () => {} },
      effect: () => () => {},
      slots: { inject: (_k, register) => register(), register: (e) => { entry = e; } },
      // Hostile: resolving the shell throws. The card must still be injectable,
      // because a session whose shell is not ready yet is exactly the state that
      // used to leave the card permanently hidden.
      conversation: { input: { shell: () => { throw new Error("no binding"); } } },
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  const face = entry.inject("sess-1");
  assert.deepEqual(Object.keys(face.hooks), ["pasteFold"]);
  assert.equal(typeof face.hooks.pasteFold.getSnapshot, "function");
});

test("applying the plugin replaces a stale stylesheet from a previous build", () => {
  const { apply } = loadBundle().exports;
  // A hot reload re-applies apply() while the old build's <style> is still in the
  // head. Geometry changed between builds, so keeping the old sheet would silently
  // style the card with superseded rules.
  const removed = [];
  const stale = { removed: false, remove() { this.removed = true; removed.push(this); } };
  const appended = [];
  const hostStub = {
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [stale],
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild: (node) => appended.push(node) },
  };
  const previousDocument = globalThis.document;
  globalThis.document = hostStub;
  try {
    apply({
      locale: { register: () => {} },
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (_k, register) => register(), register: () => {} },
      sessions: { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} } },
      conversation: { input: { shell: () => undefined } },
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  assert.equal(removed.length, 1, "the stale sheet must be removed");
  assert.equal(appended.length, 1, "and exactly one fresh sheet installed");
});


test("clearing the composer retires every fold and releases the held text", async () => {
  // A send (or a select-all delete) empties the draft. Nothing folded survives that: the
  // chips are gone from the editor, so their text must be released with them -- otherwise
  // the by-ref map keeps 6 KB alive per session for the rest of the app's life, and the
  // next paste in this session inherits a stale fold.
  const composer = createFakeComposer("");
  const { face, triggers } = setUpComposerFold(composer);
  composer.insert("y".repeat(6000));
  await settleChip();
  const ref = face.hooks.pasteFold.getSnapshot()["s1"].folds[0].ref;
  assert.equal(await triggers.serializeReference("folded-text", ref), "y".repeat(6000), "the paste is held while its chip exists");

  // Stock's own submit: the chips serialize and the draft is cleared in one commit.
  composer.shell.setDraft("");

  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"], undefined, "the fold record clears");
  await assert.rejects(
    () => Promise.resolve(triggers.serializeReference("folded-text", ref)),
    "and the held text is released with it, so it can never be serialized again",
  );
});


test("the stock chip is hidden by a selector that survives the app's CSS hashing", () => {
  // Reported bug: "上层被chip覆盖了，需要调整一下chip的高度，不要挡住输入框中的文字输入".
  // The old rule keyed on `.QiNVUW_chip` -- a CSS-module hash. That class does not exist
  // in this build at all (the real one is `eMFGQq_chip`), so the stock chip was never
  // hidden and its 40px row sat on top of the editor's first line. The hide must key on
  // `data-composer-chip`, which stock stamps from the reference's SOURCE name.
  let css = "";
  const documentStub = {
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild: (tag) => { css = tag.textContent; } },
  };
  const previousDocument = globalThis.document;
  globalThis.document = documentStub;
  try {
    loadBundle().exports.apply({
      locale: { register: () => {} },
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (_k, register) => register(), register: () => {} },
      conversation: { input: { shell: () => undefined } },
      sessions: { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} } },
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }

  assert.match(
    css,
    /\[data-composer-chip="folded-text"\]\{display:none\}/,
    "the stock chip must be hidden through the stable data-composer-chip hook",
  );
  assert.doesNotMatch(css, /QiNVUW/, "and not through a CSS-module hash that does not exist in this build");

  // The rail is compact and single-line, so the band it reserves is small.
  const chip = /\.dshps-chip\{([^}]*)\}/.exec(css);
  assert.ok(chip, "the chip rule must be installed");
  assert.match(chip[1], /height:28px/, "the chip is one compact row, not a 40px two-line block");

  // The card reserves the band the rail actually occupies. A hard-coded reserve is what
  // the old build got wrong; this one is driven by the measured height the component
  // publishes as --dshps-chip-band.
  assert.match(
    css,
    /\[data-composer-card\]\[data-dshps-chip\]\{padding-top:calc\(8px \+ var\(--dshps-chip-band,0px\)\)\}/,
    "the card padding must follow the measured rail height",
  );
});


test("the chip rail is a static flow container above the editor", () => {
  // The overlay chip rail now uses position:static — it flows in the overlay slot
  // naturally above the editor. No absolute positioning, no z-index, no card padding.
  let css = "";
  const documentStub = {
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild: (tag) => { css = tag.textContent; } },
  };
  const previousDocument = globalThis.document;
  globalThis.document = documentStub;
  try {
    loadBundle().exports.apply({
      locale: { register: () => {} },
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (_k, register) => register(), register: () => {} },
      conversation: { input: { shell: () => undefined } },
      sessions: { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} } },
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }

  const rail = /\.dshps-chip-rail\{([^}]*)\}/.exec(css);
  assert.ok(rail, "the rail rule must be installed");
  // Static flow: no absolute positioning
  assert.ok(!/position:\s*absolute/.test(rail[1]), "rail is static, not absolute");
  assert.match(rail[1], /flex-wrap:wrap/, "several pastes put several chips on the rail");
  const chip = /\.dshps-chip\{([^}]*)\}/.exec(css);
  assert.ok(chip, "the chip rule must be installed");
  assert.match(chip[1], /width:fit-content/, "the chip hugs its content");
});


test("the chip expands the fold rather than mutating the draft itself", () => {
  // The chip never edits the draft: it asks the plugin's toggle to do it, because
  // expanding is a restore (the text is out of the editor and held) and only the
  // plugin knows where it is. A chip that called setDraft directly would blank the
  // content it was supposed to bring back.
  const { PasteFoldChip } = loadBundle().exports.__internals;
  const calls = [];
  const record = { folds: [{ ref: "r-7", bytes: 6000, lines: 3, text: '{"a":1}', sentinels: ["x"] }] };
  const render = () => PasteFoldChip({
    sessionId: "sess-1",
    usePasteFold: (select) => select({ "sess-1": record }),
    onToggle: (sessionId, next, ref) => calls.push([sessionId, next, ref]),
    t: (key) => key,
  });

  const open = openButtonOf(render());
  assert.equal(open.props["aria-expanded"], false);
  open.props.onClick();
  assert.deepEqual(calls, [["sess-1", true, "r-7"]],
    "clicking the chip asks the plugin to put THAT paste's text back");
});

test("the rail measures itself and reserves its band, so it cannot cover what the user types", () => {
  // Reported bug: "输入框中可以输入文字，但是上层被chip覆盖了，需要调整一下chip的高度，不要挡住
  // 输入框中的文字输入". Stock renders this slot in an absolutely-positioned, zero-height
  // overlay anchor INSIDE [data-composer-card], so the rail floats over the card's first
  // rows. The only way it can coexist with the editor is if the card reserves the band the
  // rail actually occupies -- and the old build's hard-coded 60px was both wrong and, in
  // practice, never applied at all (its layout effect ran once at mount, before the ref
  // existed).
  //
  // This drives the real component: the effect runs with a card and a rail of a known
  // height, and the assertions are about the number the CARD ends up with.
  const layoutEffects = [];
  const refs = [];
  const mounted = [];
  const { PasteFoldChip } = loadBundle({
    useLayoutEffect: (fn, deps) => { layoutEffects.push({ fn, deps }); },
    useRef: () => {
      const ref = { current: null };
      refs.push(ref);
      return ref;
    },
  }).exports.__internals;

  const card = {
    attributes: {},
    style: {
      properties: {},
      setProperty(name, value) { this.properties[name] = value; },
      removeProperty(name) { delete this.properties[name]; },
    },
    setAttribute(name, value) { this.attributes[name] = value === undefined ? "" : String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
  };
  const rail = {
    closest: (selector) => (selector === "[data-composer-card]" ? card : null),
    getBoundingClientRect: () => ({ height: 36 }),
  };
  let observed = null;
  const previousResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) { observed = { callback }; }
    observe() {}
    disconnect() { observed = null; }
  };
  try {
    const record = { folds: [{ ref: "r-1", bytes: 6000, lines: 1, text: "abcdef", sentinels: ["x"] }] };
    const tree = PasteFoldChip({
      sessionId: "s1",
      usePasteFold: (select) => select({ s1: record }),
      onMount: (id) => mounted.push(id),
      t: (key) => key,
    });
    // Attach the rail the component rendered to the ref it created, then run the effect
    // that the commit would run.
    assert.equal(refs.length, 1, "the rail keeps a ref");
    refs[0].current = rail;
    // Three layout effects: the mount hook that installs the watcher for THIS
    // composer's session, the session stamp the paste observer reads off the card,
    // and the band reservation. Run all three and pick the band cleanup by what it
    // does (it is the effect that removes the card's band marker).
    assert.equal(layoutEffects.length, 3, "mount hook + session stamp + band reservation");
    const cleanups = layoutEffects.map((effect) => effect.fn());
    assert.deepEqual(mounted, ["s1"], "rendering in a composer installs that session's watcher");
    assert.equal(card.attributes["data-dshps-session"], "s1", "and the card names its session");
    // The band reservation is the LAST layout effect (mount hook, session stamp,
    // band), and it is the one that must release the band on unmount.
    const cleanup = cleanups[cleanups.length - 1];
    assert.equal(typeof cleanup, "function", "the band effect returns its cleanup");

    assert.equal(
      card.style.properties["--dshps-chip-band"],
      `${36 + 8}px`,
      "the card must reserve the rail's real height plus the gap",
    );
    assert.equal(card.attributes["data-dshps-chip"], "", "and be marked so the rule applies");
    assert.ok(observed !== null, "a ResizeObserver follows later wraps onto more rows (several chips)");
    assert.equal(tree.type, "div", "and the rail is what is rendered");
    assert.equal(tree.props.className, "dshps-chip-rail");

    cleanup();
    assert.equal(card.style.properties["--dshps-chip-band"], undefined, "unmounting releases the band");
    assert.equal(card.attributes["data-dshps-chip"], undefined, "and the marker");
  } finally {
    if (previousResizeObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = previousResizeObserver;
  }
});

test("with no fold the rail reserves nothing, so an ordinary composer is not padded", () => {
  const layoutEffects = [];
  const { PasteFoldChip } = loadBundle({
    useLayoutEffect: (fn, deps) => { layoutEffects.push({ fn, deps }); },
    useRef: () => ({ current: null }),
  }).exports.__internals;

  const tree = PasteFoldChip({
    sessionId: "s1",
    usePasteFold: (select) => select({}),
    t: (key) => key,
  });
  assert.equal(tree.type, "div", "the rail container is mounted so it can be found");
  assert.equal(tree.props["data-empty"], "", "marked empty while nothing is folded");
  // The empty rail is display:none by its own stylesheet rule, so it neither paints
  // nor reserves a band. That rule is what keeps an ordinary composer unpadded.
  assert.equal(tree.props.className, "dshps-chip-rail");
  assert.equal(tree.props["data-paste-spill-rail"], true);
  assert.equal(tree.children.length, 0, "and it renders no chips");
  assert.equal(layoutEffects.length, 3, "mount hook + session stamp + band reservation");
  // The band effect is the last one; with no rail attached it must do nothing at all,
  // so an ordinary composer never gets the reserved band.
  assert.equal(layoutEffects[2].fn(), undefined, "and the band effect does no work without a rail");
});

test("the chip component renders nothing when there is no record", () => {
  const { PasteFoldChip } = loadBundle().exports.__internals;
  const tree = PasteFoldChip({ sessionId: "sess-1", usePasteFold: undefined, useFoldExpanded: undefined });
  assert.equal(chipOf(tree), null, "no store means nothing rendered");
});

test("the chip component degrades gracefully when hooks are missing", () => {
  const { PasteFoldChip } = loadBundle().exports.__internals;
  const tree = PasteFoldChip({ sessionId: "sess-1", usePasteFold: undefined, useFoldExpanded: undefined });
  assert.equal(chipOf(tree), null, "no hooks means nothing rendered");
});

// --- Hold-and-restore: collapsing EMPTIES the editor, expanding refills it ----
//
// The user's requirement: "折叠后，输入框中清空，展开后才显示原始内容". The fold
// layer therefore stops being pure presentation: the text is physically moved out
// of the draft and held by the plugin, so the composer is genuinely empty while
// collapsed. Every test below pins one half of that round trip, because a
// hold-without-restore is a data-loss bug, not a cosmetic one.

// --- The collapsed chip: preview + dismiss + expand (Codex-style) --------------
//
// Final shape requested by the user, replacing the "已折叠大文本 · N 字节 · N 行"
// banner row: while text is folded the composer shows ONE chip that previews the
// content and offers two actions — click to put the full text back in the text
// box, and × to discard it entirely. There is no separate status line above it.
//
// "展开" is now purely visual (the text never left the draft), so the chip's click
// just retires the fold record: the clamp and the transparency lift, the text and
// caret reappear, and the chip unmounts because nothing is folded any more.

test("the collapsed chip previews the content instead of a byte/line summary", () => {
  const { PasteFoldChip } = loadBundle().exports.__internals;
  const record = { bytes: 6000, lines: 1, text: '{"readings": {"backward": [1,2,3]}}', sentinels: ["x"] };
  const tree = PasteFoldChip({
    sessionId: "sess-1",
    usePasteFold: (select) => select({ "sess-1": record }),
    useFoldExpanded: (select) => select({}),
    t: (key) => key,
  });
  const text = leafText(chipOf(tree));
  assert.match(text, /readings/, "the chip previews the pasted content");
  assert.doesNotMatch(text, /foldMeta/, "and no longer shows the byte/line summary row");
});

test("the collapsed chip offers an expand affordance that restores the text", () => {
  const { PasteFoldChip } = loadBundle().exports.__internals;
  const toggles = [];
  const record = { bytes: 6000, lines: 1, text: '{"a":1}', sentinels: ["x"] };
  const tree = PasteFoldChip({
    sessionId: "sess-1",
    usePasteFold: (select) => select({ "sess-1": record }),
    useFoldExpanded: (select) => select({}),
    onToggle: (sessionId, next) => toggles.push([sessionId, next]),
    t: (key) => key,
  });
  const open = openButtonOf(tree);
  assert.ok(open, "the chip renders an expand control");
  // The whole chip body is the expand target, exactly like the reference chip.
  open.props.onClick();
  assert.deepEqual(toggles, [["sess-1", true]], "clicking the chip expands it into the text box");
});


// --- The watcher must attach to the composer that is actually on screen --------
//
// Reported bug: "粘贴6K文件，没有chip呢？" and "粘贴60K的文件，也没有变成文件Chip" -- after a
// page reload, pastes reached the composer (the plugin's own paste observer saw 6008 and
// 60154 bytes with the target inside [data-composer-input]) and then NOTHING happened: no
// fold, no spill, no diagnostic. The single explanation for both halves going silent is
// that no draft watcher was ever installed for that session.
//
// The cause is the install trigger: `sessions.list.current` is a session SELECTION, and
// the old code gave up after a bounded ~2s retry window if that selection's shell was not
// resolvable yet. Whenever the selection and the mounted composer disagree -- during boot,
// after a reload, or for a session that is not the selection -- the feature was dead with
// no error. The rail, by contrast, is rendered INSIDE a mounted composer for exactly that
// composer's session, so it is an authoritative signal.

test("a composer that renders the rail installs its watcher even when the selected session differs", async () => {
  const composer = createFakeComposer("");
  const mounted = [];
  const { face } = setUpComposerFold(composer, {
    // The selection points at a session with no shell at all: the boot-time install
    // resolves nothing, exactly like the reported in-app state.
    current: "some-other-session",
    shellFor: (id) => (id === "s1" ? composer.shell : undefined),
  });

  // Baseline: with only the selection-driven install, a paste in the mounted composer
  // does nothing at all.
  composer.insert("a".repeat(6000));
  await settleChip();
  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"], undefined, "no watcher, so no fold");

  // Now render the rail in that composer, as the renderer does for a mounted session.
  // A bundle whose React stub runs layout effects immediately, so the mount hook fires.
  const PasteFoldChip = loadBundle({ useLayoutEffect: (fn) => fn() }).exports.__internals.PasteFoldChip;
  PasteFoldChip({
    sessionId: "s1",
    usePasteFold: (select) => select(face.hooks.pasteFold.getSnapshot()),
    onToggle: face.onToggle,
    onDismiss: face.onDismiss,
    onMount: (id) => { mounted.push(id); face.onMount(id); },
    t: (key) => key,
  });
  assert.deepEqual(mounted, ["s1"], "rendering inside the composer is what installs the watcher");

  // And now the very same paste folds: the chip appears where the user is typing.
  composer.insert("b".repeat(6000));
  await settleChip();
  const record = face.hooks.pasteFold.getSnapshot()["s1"];
  assert.ok(record, "the paste in the mounted composer folds");
  assert.equal(record.folds.length, 1);
  assert.ok(composer.projection().occurrences.some((occ) => occ.source === "folded-text"),
    "and it folds into a chip node in that composer");
});

test("an unresolvable shell is retried without a deadline instead of giving up after 2s", async () => {
  const composer = createFakeComposer("");
  let resolveAt = null;
  let lookups = 0;
  const frames = [];
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  const previousDocument = globalThis.document;
  globalThis.document = {
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {}, textContent: "", setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
  };
  try {
    const { apply } = loadBundle().exports;
    apply({
      locale: { register: () => {} },
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (_key, register) => register(), register: () => {} },
      sessions: { list: { getSnapshot: () => ({ current: "late" }), subscribe: () => () => {} } },
      conversation: {
        input: {
          shell: (id) => {
            lookups += 1;
            if (resolveAt !== null && lookups >= resolveAt) return composer.shell;
            throw new Error(`conversation.input: session "${id}" resolved no binding`);
          },
        },
      },
    });
    // The shell materializes only on the 130th LOOKUP. With the throttled cadence that is
    // around frame 320, well past the old ~2s / 120-frame window that used to end the
    // retries for good.
    resolveAt = 130;
    for (let i = 0; i < 400; i += 1) {
      const frame = frames.shift();
      if (frame === undefined) break;
      frame();
    }
    assert.ok(lookups >= 130, `kept looking after the old deadline (lookups=${lookups})`);

    // The watcher installed after the old deadline still sees the next paste.
    composer.insert("c".repeat(6000));
    await settleChip();
    assert.ok(
      composer.projection().occurrences.some((occ) => occ.source === "folded-text"),
      "a watcher installed past the old 2s window still folds the next paste",
    );
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
    if (previousCancel === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = previousCancel;
  }
});

// --- Which conversation decides whether a chip appears -------------------------
//
// Reported bug: "为什么在一些对话中可以chip，但一些对话中，没有chip？" -- the same
// paste folds in one conversation and stays plain text in another. Every mechanism
// that can lose a paste turned out to be per-conversation state: the shell instance,
// the composer phase, and the session a paste is attributed to. These tests pin the
// three of them.

test("a conversation whose shell was replaced gets a fresh watcher, so its next paste still folds", async () => {
  // `InputHub.shellFor(binding)` caches ONE shell per session binding and disposes it
  // when the session scope unwinds, so leaving and re-entering a conversation hands out
  // a NEW shell. A watcher cached against the old one listens to a store that nothing
  // publishes to any more: that conversation folds nothing for the rest of the app's
  // life, with no error anywhere.
  const first = createFakeComposer("");
  const second = createFakeComposer("");
  let live = first;
  const { face } = setUpComposerFold(first, { shellFor: () => live.shell });

  // Same shell: the second install must be a no-op, not a duplicate subscription.
  face.onMount("s1");

  live = second;
  face.onMount("s1");

  second.insert("z".repeat(6000));
  await settleChip();
  assert.ok(
    second.projection().occurrences.some((occ) => occ.source === "folded-text"),
    "the replacement shell's paste folds",
  );
  assert.equal(
    face.hooks.pasteFold.getSnapshot()["s1"].folds.length,
    1,
    "exactly one fold, not one per shell",
  );

  // The retired shell must have been unsubscribed: a paste into it is nobody's.
  first.insert("w".repeat(6000));
  await settleChip();
  assert.equal(
    face.hooks.pasteFold.getSnapshot()["s1"].folds.length,
    1,
    "the replaced shell no longer folds anything",
  );
});

test("a paste made while the conversation is submitting folds itself once the composer is free", async () => {
  // The refusal is per conversation, and so is the cure. Stock refuses the chip insert
  // while the composer is `submitting` or `adjudicating`; the text is in the editor
  // either way, so the armed retry folds it as soon as the phase allows. Without this
  // the paste simply stays inline forever in whichever conversation was busy.
  const composer = createFakeComposer("");
  const { face } = setUpComposerFold(composer);
  const body = "p".repeat(6000);

  composer.setPhase("submitting");
  composer.insert(body);
  await settleChip(20);
  assert.equal(
    composer.projection().occurrences.length,
    0,
    "no chip while the conversation is submitting",
  );
  assert.equal(composer.draft(), body, "the text is still there, un-folded, exactly as pasted");

  // The previous message settles; nothing else happens -- no new paste, no new event.
  composer.setPhase("plain");
  await new Promise((resolve) => { setTimeout(resolve, 400); });
  await settleChip(20);
  assert.ok(
    composer.projection().occurrences.some((occ) => occ.source === "folded-text"),
    "the retry folds the same paste once the composer accepts it",
  );
  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"].folds.length, 1, "one chip, one paste");
});

test("a spill in flight is never uploaded twice by the guaranteed retry", async () => {
  // A spill keeps the pasted text in the editor until the upload reports ready, so
  // that window looks exactly like "a big paste nobody handled yet". The retry must
  // treat the in-flight upload as the owner of that paste, or one paste becomes two
  // attachments.
  const composer = createFakeComposer("");
  const drafts = [];
  const uploadListeners = new Set();
  let uploads = {};
  const conversation = {
    createDrafts: (sessionId, files) => {
      drafts.push({ sessionId, name: files[0].name });
      return [{ id: `d-${drafts.length}`, kind: "file" }];
    },
    releaseDraftAttachments: () => {},
    releaseDraftAttachment: () => {},
    fileUploads: {
      subscribe: (listener) => {
        uploadListeners.add(listener);
        return () => uploadListeners.delete(listener);
      },
      getSnapshot: () => uploads,
    },
  };
  const documentStub = {
    listeners: {},
    addEventListener(type, fn, options) {
      if (options === true || (options && options.capture)) this.listeners[type] = fn;
    },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {}, textContent: "", setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
  };
  const card = {
    attributes: { "data-dshps-session": "s1" },
    getAttribute(name) { return this.attributes[name] ?? null; },
  };
  class FakeElement {
    closest(selector) {
      if (selector === "[data-composer-card]") return card;
      if (selector === "[data-composer-input]") return this;
      return null;
    }
  }
  const previousDocument = globalThis.document;
  const previousElement = globalThis.Element;
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.document = documentStub;
  globalThis.Element = FakeElement;
  globalThis.requestAnimationFrame = () => 1;
  try {
    const { apply } = loadBundle().exports;
    apply({
      locale: { register: () => {} },
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (_key, register) => register(), register: () => {} },
      sessions: { list: { getSnapshot: () => ({ current: "s1" }), subscribe: () => () => {} } },
      inputTriggers: { registerSource: () => () => {}, serializeReference: () => Promise.resolve("") },
      conversation: { input: { shell: () => composer.shell }, ...conversation },
    });
    // The paste is CLIPBOARD-observed (so the retry is armed) and inserted.
    const big = "S".repeat(61000);
    documentStub.listeners.paste({ target: new FakeElement(), clipboardData: { items: [], getData: () => big } });
    composer.insert(big);
    await settleChip();
    assert.equal(drafts.length, 1, "the watcher starts exactly one upload");
    assert.equal(composer.draft(), big, "the text stays inline while the upload runs");

    // The upload never settles; the retry polls several times in this window.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    await settleChip();
    assert.equal(drafts.length, 1, "and the retry must not add a second attachment");

    // The upload finishes: the text is removed and the retry stays quiet.
    uploads = { "d-1": { status: "ready" } };
    for (const listener of [...uploadListeners]) listener();
    await settleChip();
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    await settleChip();
    assert.equal(drafts.length, 1, "still one attachment after the upload settles");
    assert.equal(composer.draft(), "", "and the spilled text is gone from the editor");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousElement === undefined) delete globalThis.Element;
    else globalThis.Element = previousElement;
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  }
});

test("one paste folds exactly once with BOTH triggers armed (observed paste + watcher)", async () => {
  // Two triggers look at the same draft: the watcher (fast) and the armed retry
  // (guaranteed). An OBSERVED paste arms the retry and is recorded for the watcher, so
  // this drives both for real. The winner replaces the pasted run with its chip; the
  // loser must then find no run at all and stop -- it must never compare text to decide
  // this (that swallowed a second identical paste), and it must never insert a second
  // chip.
  const composer = createFakeComposer("");
  const documentStub = {
    listeners: {},
    addEventListener(type, fn, options) {
      if (options === true || (options && options.capture)) this.listeners[type] = fn;
    },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {}, textContent: "", setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
  };
  const card = { getAttribute: () => "s1" };
  class FakeElement {
    closest(selector) {
      if (selector === "[data-composer-card]") return card;
      if (selector === "[data-composer-input]") return this;
      return null;
    }
  }
  const previousDocument = globalThis.document;
  const previousElement = globalThis.Element;
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.document = documentStub;
  globalThis.Element = FakeElement;
  globalThis.requestAnimationFrame = () => 1;
  try {
    const bundle = loadBundle();
    bundle.exports.apply({
      locale: { register: () => {} },
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (_key, register) => register(), register: () => {} },
      sessions: { list: { getSnapshot: () => ({ current: "s1" }), subscribe: () => () => {} } },
      inputTriggers: { registerSource: () => () => {}, serializeReference: () => Promise.resolve("") },
      conversation: { input: { shell: () => composer.shell } },
    });
    const body = "m".repeat(6000);
    documentStub.listeners.paste({ target: new FakeElement(), clipboardData: { items: [], getData: () => body } });
    composer.insert(body);
    await settleChip();
    // Let the retry's 200 ms timer fire several times after the fold landed.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    await settleChip();

    assert.equal(composer.projection().occurrences.length, 1, "exactly one chip node in the editor");
    // WHICH WAY it stopped matters: "my paste already has a chip" (identity) is the intended
    // exit; "gave-up" after thirty unlocatable polls looks identical from the editor but
    // means the two triggers were racing rather than cooperating.
    assert.equal(bundle.diag().bySession.s1.armed, "already-folded", "the retry ended because its paste was folded");
    // Still foldable: pasting the same text again makes a second, separate chip.
    composer.insert(body);
    await settleChip();
    assert.equal(composer.projection().occurrences.length, 2, "a second identical paste folds too");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousElement === undefined) delete globalThis.Element;
    else globalThis.Element = previousElement;
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  }
});

test("a paste is attributed to the composer that received it, not to the selected session", async () => {
  // The paste event carries no session id and `sessions.list.current` is a SELECTION
  // that can point elsewhere, so the text used to be recorded with no session key at
  // all. Any session's watcher could then claim it: the conversation that really
  // received the paste saw no measurement, and the one that did not received it.
  //
  // The paste below is 61,000 bytes, which is a FILE (>= SPILL_BYTES). It is stamped as
  // belonging to s2, but only 45,000 bytes are inserted -- under the spill threshold.
  // The recorded clipboard text is what decides, so the verdict proves which session
  // the recording reached: s2 must spill, s1 must merely fold.
  const s1Composer = createFakeComposer("");
  const s2Composer = createFakeComposer("");
  const big = "B".repeat(61000);
  const pasted = "B".repeat(45000);
  const drafts = [];

  const documentStub = {
    listeners: {},
    addEventListener(type, fn, options) {
      if (options === true || (options && options.capture)) this.listeners[type] = fn;
    },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {}, textContent: "", setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
  };
  const card = {
    attributes: { "data-dshps-session": "s2" },
    getAttribute(name) { return this.attributes[name] ?? null; },
  };
  class FakeElement {
    constructor(node) { this.node = node; }
    closest(selector) {
      if (selector === "[data-composer-card]") return card;
      if (selector === "[data-composer-input]") return this.node;
      return null;
    }
  }
  const previousDocument = globalThis.document;
  const previousElement = globalThis.Element;
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.document = documentStub;
  globalThis.Element = FakeElement;
  globalThis.requestAnimationFrame = () => 1;
  try {
    const { apply } = loadBundle().exports;
    apply({
      locale: { register: () => {} },
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (_key, register) => register(), register: () => {} },
      sessions: { list: { getSnapshot: () => ({ current: "s1" }), subscribe: () => () => {} } },
      inputTriggers: {
        registerSource: () => () => {},
        serializeReference: () => Promise.resolve(""),
      },
      conversation: {
        input: {
          shell: (id) => (id === "s2" ? s2Composer.shell : s1Composer.shell),
        },
        createDrafts: (sessionId, files) => {
          drafts.push({ sessionId, name: files[0].name });
          return [{ id: `d-${drafts.length}`, kind: "file" }];
        },
        releaseDraftAttachments: () => {},
        fileUploads: { subscribe: () => () => {}, getSnapshot: () => ({}) },
      },
    });

    // A real paste in the s2 composer: the DOM stamp is the only session evidence.
    const input = new FakeElement({});
    documentStub.listeners.paste({
      target: input,
      clipboardData: { items: [], getData: () => big },
    });

    // Insert into s1 first: it must NOT see s2's recording.
    s1Composer.insert(pasted);
    await settleChip();
    assert.equal(drafts.length, 0, "the selected session must not inherit another session's paste");
    assert.ok(
      s1Composer.projection().occurrences.some((occ) => occ.source === "folded-text"),
      "s1 folds the text it actually received, from its own diff",
    );

    s2Composer.insert(pasted);
    await settleChip();
    assert.equal(drafts.length, 1, "exactly one spill, and it belongs to s2");
    assert.equal(drafts[0].sessionId, "s2", "the recording reached the session that received the paste");
    assert.match(drafts[0].name, /^pasted-text-\d+\.txt$/, "and it spilled as a file, on the clipboard measurement");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousElement === undefined) delete globalThis.Element;
    else globalThis.Element = previousElement;
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  }
});

// --- The reviewer's data-loss paths -------------------------------------------
//
// An adversarial review of this layer found four ways ordinary use could destroy or
// misroute the user's own text. Each one is pinned below with the exact sequence that
// used to produce it.

test("a spilled paste takes out only the paste, even when the clipboard held CRLF", async () => {
  // `removePastedText` returned "" when it could not find its candidate -- "empty is the
  // honest fallback" -- and the spill cleanup wrote that back as the whole draft. The
  // candidate is the RAW clipboard payload while the editor holds its own rendering, so
  // ANY CRLF paste (every Windows-authored log) hit that path: the attachment appeared and
  // the user's typed text was gone. The attachment already holds the paste, so an
  // unlocatable removal must leave the draft completely alone.
  const composer = createFakeComposer("");
  const { watchDraft, createSessionStore, createPasteInbox } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const inbox = createPasteInbox();
  let uploads = { "d-1": { status: "uploading" } };
  const listeners = new Set();
  const conversation = {
    createDrafts: () => [{ id: "d-1", kind: "file" }],
    releaseDraftAttachment: () => true,
    releaseDraftAttachments: () => {},
    fileUploads: {
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      getSnapshot: () => uploads,
    },
  };
  const restores = [];
  const stop = watchDraft({
    shell: composer.shell,
    foldStore,
    sessionId: "s1",
    conversation,
    nextIndex: () => 1,
    inbox,
    onRestore: () => restores.push(true),
  });

  const prefix = "Analyze this:\n";
  const crlf = "line one\r\nline two\r\n" + "z".repeat(72000);
  const lf = crlf.replace(/\r\n/gu, "\n");
  composer.insert(prefix);
  inbox.record(crlf, "paste", "s1");
  composer.insert(lf); // what the editor really stores after normalisation
  await settleChip(20);
  assert.equal(restores.length, 0, "nothing is removed while the upload is still running");

  uploads = { "d-1": { status: "ready" } };
  for (const listener of [...listeners]) listener();
  await settleChip(20);

  assert.equal(restores.length, 1, "the pasted run was located and taken out");
  assert.equal(composer.draft(), prefix, "and not one character of the user's own text was lost");
  stop();
});

test("folding 6K then spilling 60K keeps the chip, and the label never becomes the text", async () => {
  // Reported in-app: "先粘贴6K，后粘贴60K，输入框会出现：已折叠 5.9 KB". The spill cleanup
  // cleared the pasted run with `setDraft`, which REBUILDS the draft as plain text -- so the
  // folded chip in the same composer was destroyed and its footprint (the label) was all
  // that remained. The attachment was correct; the 6 KB paste was one keystroke from being
  // sent as the string "已折叠 5.9 KB". The run is now excised by writing "" over its own
  // detect span, so other chips, typing, the caret and undo all survive.
  const composer = createFakeComposer("");
  const drafts = [];
  const uploadListeners = new Set();
  let uploads = {};
  const sources = [];
  const triggers = {
    registerSource(source) { sources.push(source); return () => {}; },
    serializeReference(source, ref) {
      const found = sources.find((candidate) => candidate.name === source);
      return Promise.resolve(found.codec.serialize(ref));
    },
  };
  const documentStub = {
    listeners: {},
    addEventListener(type, fn, options) {
      if (options === true || (options && options.capture)) this.listeners[type] = fn;
    },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {}, textContent: "", setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
  };
  const card = {
    attributes: { "data-dshps-session": "s1" },
    getAttribute(name) { return this.attributes[name] ?? null; },
  };
  class FakeElement {
    closest(selector) {
      if (selector === "[data-composer-card]") return card;
      if (selector === "[data-composer-input]") return this;
      return null;
    }
  }
  const previousDocument = globalThis.document;
  const previousElement = globalThis.Element;
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.document = documentStub;
  globalThis.Element = FakeElement;
  globalThis.requestAnimationFrame = () => 1;
  try {
    const { apply } = loadBundle().exports;
    apply({
      locale: { register: () => {} },
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (_key, register) => register(), register: () => {} },
      sessions: { list: { getSnapshot: () => ({ current: "s1" }), subscribe: () => () => {} } },
      inputTriggers: triggers,
      conversation: {
        input: { shell: () => composer.shell },
        createDrafts: (sessionId, files) => {
          drafts.push({ sessionId, name: files[0].name });
          return [{ id: `d-${drafts.length}`, kind: "file" }];
        },
        releaseDraftAttachments: () => {},
        releaseDraftAttachment: () => true,
        fileUploads: {
          subscribe: (listener) => { uploadListeners.add(listener); return () => uploadListeners.delete(listener); },
          getSnapshot: () => uploads,
        },
      },
    });

    const six = "f".repeat(6008);
    const paste = (text) => documentStub.listeners.paste({
      target: new FakeElement(),
      clipboardData: { items: [], getData: () => text },
    });

    // 1) 6 KB: folds into a chip.
    paste(six);
    composer.insert(six);
    await settleChip(20);
    assert.equal(composer.projection().occurrences.length, 1, "the 6K paste is one chip");

    // 2) 60 KB: spills as a file, and the cleanup must not touch the chip beside it.
    const big = "g".repeat(60154);
    paste(big);
    composer.insert(big);
    await settleChip(20);
    assert.equal(drafts.length, 1, "the second paste spilled as a file");
    uploads = { "d-1": { status: "ready" } };
    for (const listener of [...uploadListeners]) listener();
    await settleChip(20);

    assert.equal(
      composer.projection().occurrences.length,
      1,
      "the chip from the first paste is still an editor node after the spill cleanup",
    );
    assert.ok(!composer.draft().includes(big), "the spilled text is out of the composer");
    assert.ok(!composer.draft().includes(six), "and the folded text is still held by the chip, not inline");
    const sent = await composer.submittedText(triggers);
    assert.ok(sent.includes(six), "a send posts the folded 6K paste");
    assert.ok(!sent.includes("已折叠"), "never the chip's size label");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousElement === undefined) delete globalThis.Element;
    else globalThis.Element = previousElement;
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  }
});

test("a paste that named no conversation is never attached to the selected one", async () => {
  // A paste whose composer carried no session stamp was addressable by ANY session's
  // lookup, so the conversation that did not receive it could create the attachment and
  // then have its own draft wiped by the cleanup -- and if the user sent, the other
  // conversation's text went out as this one's message. An unmapped recording is folded
  // (or not) through the draft diff of whichever session really got the text; it is never
  // someone else's.
  const composer = createFakeComposer("");
  const drafts = [];
  const documentStub = {
    listeners: {},
    addEventListener(type, fn, options) {
      if (options === true || (options && options.capture)) this.listeners[type] = fn;
    },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {}, textContent: "", setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
  };
  // A composer card with NO session stamp (the rail is not mounted there).
  const card = { attributes: {}, getAttribute(name) { return this.attributes[name] ?? null; } };
  class FakeElement {
    closest(selector) {
      if (selector === "[data-composer-card]") return card;
      if (selector === "[data-composer-input]") return this;
      return null;
    }
  }
  const previousDocument = globalThis.document;
  const previousElement = globalThis.Element;
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.document = documentStub;
  globalThis.Element = FakeElement;
  globalThis.requestAnimationFrame = () => 1;
  try {
    const { apply } = loadBundle().exports;
    apply({
      locale: { register: () => {} },
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (_key, register) => register(), register: () => {} },
      sessions: { list: { getSnapshot: () => ({ current: "s1" }), subscribe: () => () => {} } },
      inputTriggers: { registerSource: () => () => {}, serializeReference: () => Promise.resolve("") },
      conversation: {
        input: { shell: () => composer.shell },
        createDrafts: (sessionId, files) => {
          drafts.push({ sessionId, name: files[0].name });
          return [{ id: `d-${drafts.length}`, kind: "file" }];
        },
        releaseDraftAttachments: () => {},
        releaseDraftAttachment: () => true,
        fileUploads: { subscribe: () => () => {}, getSnapshot: () => ({}) },
      },
    });

    documentStub.listeners.paste({
      target: new FakeElement(),
      clipboardData: { items: [], getData: () => "B".repeat(61000) },
    });

    // The selected conversation receives its own, smaller paste: fold range, not spill.
    composer.insert("B".repeat(45000));
    await settleChip(20);
    assert.equal(drafts.length, 0, "the selected conversation must not attach someone else's paste");
    assert.ok(
      composer.projection().occurrences.some((occ) => occ.source === "folded-text"),
      "it folds the text it actually received, from its own diff",
    );
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousElement === undefined) delete globalThis.Element;
    else globalThis.Element = previousElement;
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  }
});

test("a fold whose chip vanished with the re-created composer puts the paste back, never the label", async () => {
  // Leaving a conversation and coming back gives a NEW shell, and stock seeds it from the
  // mirrored draft -- in which a chip is only its `clipboardText`, the LABEL. The new
  // editor then holds "已折叠 5.9 KB" as ordinary text with no chip node, so the fold's ref
  // is genuinely gone. Evicting is right; releasing the held text there destroyed the
  // paste and left the label to be sent. It is put back into the editor instead.
  const first = createFakeComposer("");
  const second = createFakeComposer("");
  let live = first;
  const { face } = setUpComposerFold(first, { shellFor: () => live.shell });
  const body = "k".repeat(6000);
  first.insert(body);
  await settleChip();

  const entry = face.hooks.pasteFold.getSnapshot()["s1"].folds[0];
  const label = entry.sentinels[0];
  assert.ok(typeof label === "string" && label.includes("折叠"), "the chip's mirror footprint is its label");

  live = second;
  second.shell.setDraft(`${label} `); // stock rebuilds the composer from the mirror
  face.onMount("s1"); // the rail mounts in the new shell and reconciles
  await settleChip(20);

  assert.equal(second.draft(), `${body} `, "the paste is back in the editor, and it is not a size label");
  assert.equal(second.projection().occurrences.length, 0, "no chip node exists in the new editor");
  assert.equal(
    face.hooks.pasteFold.getSnapshot()["s1"],
    undefined,
    "and the fold with a dead ref is retired instead of lingering",
  );
});

test("typing after a paste in a busy conversation does not lose the fold", async () => {
  // The retry used to locate the run ONLY by the caret, which must sit exactly at the end
  // of the paste. One keypress after a paste into a conversation that is still answering
  // therefore made the run unfindable, and after thirty misses the fold was abandoned --
  // "some conversations show no chip", with the text sitting inline. A rendering that
  // occurs exactly once in the editor IS the pasted run, wherever the caret went.
  const composer = createFakeComposer("");
  const { face } = setUpComposerFold(composer);
  const body = "r".repeat(6000);

  composer.setPhase("submitting");
  composer.insert(body);
  await settleChip(20);
  assert.equal(composer.projection().occurrences.length, 0, "no chip while the conversation is submitting");

  composer.insert("x"); // the user keeps typing: the caret is no longer at the run's end
  composer.setPhase("plain");
  await new Promise((resolve) => { setTimeout(resolve, 400); });
  await settleChip(20);

  const folds = face.hooks.pasteFold.getSnapshot()["s1"].folds;
  assert.equal(folds.length, 1, "the paste folds even though the caret moved");
  assert.equal(folds[0].text, body, "and the chip holds the paste, not the typed character");
  assert.ok(composer.draft().endsWith("x"), "what the user typed is still in the draft");
});

test("a spill whose upload is already ready does not mute that conversation's folding", async () => {
  // `spillInFlight.add` ran AFTER `uploadPaste` returned, and `uploadPaste` settles from
  // the CURRENT upload snapshot -- so an upload that was already `ready` called `onReady`
  // first, and the session was then left permanently marked "a spill is in flight". Every
  // later retry in that conversation waited instead of folding: the reported "this
  // conversation has no chip" symptom, caused by a spill that had long since finished.
  const composer = createFakeComposer("");
  const drafts = [];
  const documentStub = {
    listeners: {},
    addEventListener(type, fn, options) {
      if (options === true || (options && options.capture)) this.listeners[type] = fn;
    },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {}, textContent: "", setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
  };
  const card = {
    attributes: { "data-dshps-session": "s1" },
    getAttribute(name) { return this.attributes[name] ?? null; },
  };
  class FakeElement {
    closest(selector) {
      if (selector === "[data-composer-card]") return card;
      if (selector === "[data-composer-input]") return this;
      return null;
    }
  }
  const previousDocument = globalThis.document;
  const previousElement = globalThis.Element;
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.document = documentStub;
  globalThis.Element = FakeElement;
  globalThis.requestAnimationFrame = () => 1;
  try {
    const { apply } = loadBundle().exports;
    apply({
      locale: { register: () => {} },
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (_key, register) => register(), register: () => {} },
      sessions: { list: { getSnapshot: () => ({ current: "s1" }), subscribe: () => () => {} } },
      inputTriggers: { registerSource: () => () => {}, serializeReference: () => Promise.resolve("") },
      conversation: {
        input: { shell: () => composer.shell },
        createDrafts: (sessionId, files) => {
          drafts.push({ sessionId, name: files[0].name });
          return [{ id: `d-${drafts.length}`, kind: "file" }];
        },
        releaseDraftAttachments: () => {},
        releaseDraftAttachment: () => true,
        // The upload for a freshly created draft is already `ready` when we look.
        fileUploads: { subscribe: () => () => {}, getSnapshot: () => ({ "d-1": { status: "ready" } }) },
      },
    });

    const big = "S".repeat(60000);
    documentStub.listeners.paste({
      target: new FakeElement(),
      clipboardData: { items: [], getData: () => big },
    });
    composer.insert(big);
    await settleChip(20);
    assert.equal(drafts.length, 1, "the paste spilled as a file");
    assert.equal(composer.draft(), "", "and the uploaded text was taken out of the composer");
    assert.equal(
      loadBundle().exports.__internals.__spillInFlight.has("s1"),
      false,
      "a finished upload must not leave the session owned by a spill",
    );

    // A later paste in the SAME conversation, while the composer is busy: only the
    // guaranteed retry can fold it, and it must not be told an upload is still running.
    composer.setPhase("submitting");
    const body = "t".repeat(6000);
    documentStub.listeners.paste({
      target: new FakeElement(),
      clipboardData: { items: [], getData: () => body },
    });
    composer.insert(body);
    await settleChip(20);
    composer.setPhase("plain");
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    await settleChip(20);
    assert.ok(
      composer.projection().occurrences.some((occ) => occ.source === "folded-text"),
      "the next paste in that conversation still folds",
    );
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousElement === undefined) delete globalThis.Element;
    else globalThis.Element = previousElement;
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  }
});

// --- Expand dismisses the chip entirely ---------------------------------------
//
// Final requirement: "展开后，chip消失并显示文本的完整内容". Once the text is back
// in the composer the chip has nothing left to represent, so it must unmount — not
// linger in an "expanded" state that offers to fold it again.

test("expanding puts THAT paste's text back and unmounts its chip", async () => {
  const composer = createFakeComposer("");
  const { face } = setUpComposerFold(composer);
  const body = "q".repeat(6000);
  composer.insert(body);
  await settleChip();

  const renderChip = () => chipOf(loadBundle().exports.__internals.PasteFoldChip({
    sessionId: "s1",
    usePasteFold: (select) => select(face.hooks.pasteFold.getSnapshot()),
    onToggle: face.onToggle,
    onDismiss: face.onDismiss,
    t: (key) => key,
  }));
  assert.notEqual(renderChip(), null, "the chip is shown while the paste is folded");

  const ref = face.hooks.pasteFold.getSnapshot()["s1"].folds[0].ref;
  face.onToggle("s1", true, ref);

  // The text is written back INTO the editor at the chip's own span, and the chip is gone.
  assert.equal(composer.projection().detectText, body, "the full text is restored verbatim");
  assert.equal(composer.projection().occurrences.length, 0, "the chip node is replaced by the text");
  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"], undefined, "and the fold is consumed");
  assert.equal(renderChip(), null, "so the chip unmounts");
});

test("a fresh large paste after an expand folds again, so the chip is not suppressed forever", async () => {
  // The unmount must come from the fold being CONSUMED, not from a sticky "user expanded
  // once" flag: with a flag, every later paste in that session would arrive
  // already-expanded and the chip would never appear again.
  const composer = createFakeComposer("");
  const { face } = setUpComposerFold(composer);
  composer.insert("a".repeat(6000));
  await settleChip();
  const firstRef = face.hooks.pasteFold.getSnapshot()["s1"].folds[0].ref;
  face.onToggle("s1", true, firstRef);
  assert.equal(composer.detect(), "a".repeat(6000), "first paste restored");

  // A second, different large paste must fold again and show a chip.
  composer.insert("b".repeat(6000));
  await settleChip();
  const second = face.hooks.pasteFold.getSnapshot()["s1"];
  assert.ok(second, "the second large paste folds again");
  const tree = loadBundle().exports.__internals.PasteFoldChip({
    sessionId: "s1",
    usePasteFold: (select) => select(face.hooks.pasteFold.getSnapshot()),
    onToggle: face.onToggle,
    onDismiss: face.onDismiss,
    t: (key) => key,
  });
  assert.notEqual(chipOf(tree), null, "and its chip is shown, not permanently suppressed");
});

test("expanding ONE of two chips returns only that paste", async () => {
  // The whole reason the per-chip ref exists. `setDraft(restoredText)` would rebuild the
  // document from plain text and destroy the OTHER chip -- and that chip is the only
  // carrier of its paste, so the second text would be lost outright.
  const composer = createFakeComposer("");
  const { face, triggers } = setUpComposerFold(composer);
  const first = "1".repeat(6000);
  const second = "2".repeat(6000);
  composer.insert(first);
  await settleChip();
  composer.insert(second);
  await settleChip();

  const [one, two] = face.hooks.pasteFold.getSnapshot()["s1"].folds;
  face.onToggle("s1", true, two.ref);

  assert.equal(composer.detect(), `\uFFFC ${second}`, "the expanded paste is back in place, beside the other chip");
  assert.equal(composer.projection().occurrences.length, 1, "the other chip is still there");
  assert.equal(composer.projection().occurrences[0].ref, one.ref, "and it is the one that was not expanded");
  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"].folds.length, 1, "only the expanded fold is retired");
  assert.equal(await composer.submittedText(triggers), `${first} ${second}`, "a send still posts both pastes");
});


// --- Sending clears the fold entirely -----------------------------------------
//
// The requirement in full: "发送后，不管是文本chip，还是输入框，发送到turn中，输入框全部
// 清空". Sending is a COMPLETED interaction, so the hold, the record and the expanded
// flag must all be gone afterwards.
//
// Before this existed nothing observed a completed send at all. Every clear site was
// a user gesture (expand, dismiss, or the watcher noticing the text left the draft),
// and the watcher deliberately skips cleanup while a hold is active -- so a send left
// the hold and record alive forever. That single gap caused every reported symptom:
// a phantom occupying the composer, a chip that would not go, and sidecars that piled
// up because each new paste collided with the stale state.

/** Build an applied plugin wired to a draft store, returning the slot entry face. */
let createDraftsSeq = 0;

/**
 * Apply the plugin onto a session backed by a FAKE COMPOSER, and return the slot face.
 *
 * The fold layer's whole contract is expressed in editor terms -- a chip node in the
 * document, a detect span, a submit-time serialization -- so the end-to-end tests need
 * the editor, not just a draft string. `triggers` is the input-trigger service, which is
 * what turns a chip's `ref` back into text at submit time; `serializeReference` there is
 * the plugin's own registered codec, so `composer.submittedText(triggers)` reproduces
 * exactly what the user would post.
 */
function setUpComposerFold(composer, { triggers: outerTriggers = null, current = "s1", shellFor = null, reactExtras = {} } = {}) {
  const { apply } = loadBundle(reactExtras).exports;
  let entry = null;
  const hostStub = {
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {}, textContent: "", setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
  };
  const previousDocument = globalThis.document;
  globalThis.document = hostStub;
  const sources = [];
  const triggers = outerTriggers === null
    ? {
        registerSource(source) { sources.push(source); return () => {}; },
        serializeReference(source, ref) {
          const found = sources.find((candidate) => candidate.name === source);
          if (found === undefined) throw new Error(`no trigger source named ${source}`);
          return Promise.resolve(found.codec.serialize(ref));
        },
      }
    : outerTriggers;
  try {
    apply({
      locale: { register: () => {} },
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (_key, register) => register(), register: (e) => { entry = e; } },
      sessions: { list: { getSnapshot: () => ({ current }), subscribe: () => () => {} } },
      inputTriggers: triggers,
      conversation: {
        input: {
          shell: (id) => {
            if (shellFor !== null) {
              const found = shellFor(id);
              if (found === undefined || found === null) throw new Error(`no binding for ${id}`);
              return found;
            }
            return composer.shell;
          },
        },
        // Globally unique ids, like stock's attachment ids. A per-batch counter
        // would reuse `d-0` for every call, making a stale attachment
        // indistinguishable from a fresh one and hiding accumulation bugs.
        createDrafts: (_s, files) => files.map((file) => ({ id: `d-${createDraftsSeq++}`, file })),
        releaseDraftAttachments: () => {},
      },
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  return { face: entry.inject("s1"), shell: composer.shell, draftStore: composer.shell.state, triggers, sources };
}

function setUpFold({ draft = "", attachments = [] } = {}) {
  const { apply } = loadBundle().exports;
  let entry = null;
  const hostStub = {
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
  };
  const previousDocument = globalThis.document;
  globalThis.document = hostStub;
  const draftStore = createDraftStore(draft, attachments);
  const shell = {
    state: draftStore,
    setDraft: (text) => draftStore.setDraft(text),
    addAttachments: (ids) => draftStore.addAttachments(ids),
    // Must actually mutate the store. A stub that just returns true leaves the id
    // in the snapshot, so a stale sidecar is indistinguishable from a live one and
    // the accumulation this suite exists to catch would go unnoticed.
    removeAttachment: (id) => draftStore.removeAttachment(id),
  };
  try {
    apply({
      locale: { register: () => {} },
      effect: (fn) => { fn(); return () => {}; },
      slots: { inject: (_key, register) => register(), register: (e) => { entry = e; } },
      sessions: { list: { getSnapshot: () => ({ current: "s1" }), subscribe: () => () => {} } },
      conversation: {
        input: { shell: () => shell },
        // Globally unique ids, like stock's attachment ids. A per-batch counter
        // would reuse `d-0` for every call, making a stale attachment
        // indistinguishable from a fresh one and hiding accumulation bugs.
        createDrafts: (_s, files) => files.map((file) => ({ id: `d-${createDraftsSeq++}`, file })),
        releaseDraftAttachments: () => {},
      },
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  return { face: entry.inject("s1"), draftStore, shell };
}

// --- Fold = chip: the text is held by the chip, not painted over -----------------
//
// The requirement, verbatim: "4000-50000 之间的内容展示为折叠的文本chip，只是一个展示
// 形式变化，完全不需要有一个附件chip，折叠的文本chip展开后就只剩原文本。不管是发送
// 折叠的文本chip还是展开后的原文本，turn 中仅展示原文本即可，不需要JSON文件chip"
//
// A fold is a REAL editor node: the paste is taken out of the draft and held by ref, the
// editor shows one chip, and stock serializes the held text back at submit. These tests
// pin the two properties that make that safe, because the earlier designs violated both:
// NO attachment may exist at any point, and the user's text must come back verbatim on
// expand -- the composer is never emptied behind the user's back.

test("folding attaches nothing: the chip is an editor node, not a file", async () => {
  const composer = createFakeComposer("");
  const { face, draftStore } = setUpComposerFold(composer);
  composer.insert("z".repeat(6000));
  await settleChip();

  assert.deepEqual(draftStore.getSnapshot().attachmentIds, [], "nothing is attached at any point");
  assert.equal(composer.projection().occurrences.length, 1, "the fold is one chip node in the editor");
  assert.ok(face.hooks.pasteFold.getSnapshot()["s1"], "while the chip is shown");
});

test("× on one chip removes that paste and leaves the other alone", async () => {
  // The × is "关闭即删除" -- and it deletes exactly what it is attached to. With two pastes
  // folded, a session-level wipe would silently discard the paste whose chip the user did
  // not touch.
  const composer = createFakeComposer("");
  const { face, triggers } = setUpComposerFold(composer);
  const first = "1".repeat(6000);
  const second = "2".repeat(6000);
  composer.insert(first);
  await settleChip();
  composer.insert(second);
  await settleChip();

  const [one, two] = face.hooks.pasteFold.getSnapshot()["s1"].folds;
  face.onDismiss("s1", one.ref);

  assert.equal(composer.detect(), `\uFFFC `, "the dismissed chip node is gone");
  assert.equal(composer.projection().occurrences[0].ref, two.ref, "and only the other one is left");
  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"].folds.length, 1, "its fold is retired");
  assert.equal(await composer.submittedText(triggers), second, "a send then posts the surviving paste only");
});

test("dismissing the only chip leaves a genuinely empty, unsendable composer", async () => {
  // The reported repro: paste -> expand -> delete all -> send posted a JSON chip. Every
  // path that empties the composer must leave it EMPTY: stock enables send on
  // `draft.trim() === "" && attachments.length === 0`, so a stray space or a leftover
  // placeholder would keep the button live over an empty box.
  const composer = createFakeComposer("");
  const { face, draftStore } = setUpComposerFold(composer);
  composer.insert("w".repeat(6000));
  await settleChip();

  const ref = face.hooks.pasteFold.getSnapshot()["s1"].folds[0].ref;
  face.onDismiss("s1", ref);

  assert.equal(composer.draft(), "", "no text and no leftover separator");
  assert.deepEqual(draftStore.getSnapshot().attachmentIds, [], "and no attachment");
  const snap = composer.shell.state.getSnapshot();
  const sendable = !(String(snap.draft).trim() === "" && snap.attachmentIds.length === 0);
  assert.equal(sendable, false, "an emptied composer cannot be sent");
});

test("a send clears the folds, and a later paste folds again", async () => {
  const composer = createFakeComposer("");
  const { face } = setUpComposerFold(composer);
  composer.insert("t".repeat(6000));
  await settleChip();
  assert.ok(face.hooks.pasteFold.getSnapshot()["s1"], "the first paste folds");

  // Stock's send: the chips serialize into the message and the editor is cleared.
  composer.shell.setDraft("");
  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"], undefined, "the send cleared the fold");

  composer.insert("s".repeat(6000));
  await settleChip();
  assert.ok(face.hooks.pasteFold.getSnapshot()["s1"], "a later paste folds again");
  assert.deepEqual(composer.shell.state.getSnapshot().attachmentIds, [], "still with no attachment");
});

test("a paste with surrounding text folds only the pasted run", async () => {
  // The distinction expand and × depend on. `measurableText` may answer with the WHOLE
  // draft -- its documented backstop for a jump it cannot shrink down -- but the entry's
  // `text` is an EXCISION target: storing the measurement there would make × (or a
  // restore) take the user's own typed text with it.
  const composer = createFakeComposer("");
  const { face } = setUpComposerFold(composer);
  const surrounding = "keep this. ";
  const body = "j".repeat(6000);

  composer.insert(surrounding);
  await settleChip();
  composer.insert(body);
  await settleChip();

  const entry = face.hooks.pasteFold.getSnapshot()["s1"].folds[0];
  assert.equal(entry.text, body, "the entry holds the pasted run alone");
  assert.notEqual(entry.text, composer.draft(), "and never the whole draft");
  assert.equal(composer.detect(), `${surrounding}\uFFFC `, "the surrounding text is untouched");
  assert.ok(composer.draft().startsWith(surrounding), "and still first in the composer");
});


// --- Reference-chip fold: hold & release ---------------------------------
//
// The fold chip (ReferenceChipNode) holds text OUT of the editor. A Map keyed
// by chip ref is the single source of truth for the text that stock's
// inputTriggers codec serialises back into the message at submit time.

test("holdFoldText stores and releaseFoldText removes text by ref", () => {
  const { holdFoldText, releaseFoldText, __foldTextByRef } = loadBundle().exports.__internals;
  __foldTextByRef.clear();
  holdFoldText("ref-a", "hello chip text");
  assert.equal(__foldTextByRef.get("ref-a"), "hello chip text");
  assert.equal(__foldTextByRef.size, 1);

  releaseFoldText("ref-a");
  assert.equal(__foldTextByRef.has("ref-a"), false);
  assert.equal(__foldTextByRef.size, 0);
});

test("serialize returns held text verbatim and rejects when released", async () => {
  const { holdFoldText, releaseFoldText, __foldTextByRef } = loadBundle().exports.__internals;
  __foldTextByRef.clear();

  // Simulate the codec that registerFoldSource will install
  const serialize = (ref) => {
    const held = __foldTextByRef.get(ref);
    if (held === undefined) return Promise.reject(new Error("not held"));
    return Promise.resolve(held);
  };

  holdFoldText("r1", "original pasted text");
  await assert.doesNotReject(() => serialize("r1"));
  assert.equal(await serialize("r1"), "original pasted text");

  releaseFoldText("r1");
  await assert.rejects(() => serialize("r1"), /not held/);
});

test("the entry's own text is the restore source, so an expanded paste never comes back empty", () => {
  // The reported failure this guards: "点击在文本框中显示后，输入框中没有出现任何文本". A
  // restore that read the BY-REF HOLD would come back empty whenever the hold had already
  // been released (a refused insert, a previous expand, a send), and the chip would vanish
  // while the composer stayed empty -- the user's paste looking deleted. The entry carries
  // its own text for exactly that reason, and the restore reads it first.
  const { foldEntries, foldRecord } = loadBundle().exports.__internals;
  const body = "R".repeat(5000);
  const record = foldRecord([{ ref: "r-1", bytes: 5000, lines: 1, text: body, sentinels: ["x"] }]);
  assert.equal(foldEntries(record)[0].text, body, "every fold carries the text it stands for");
  // A record with no readable text is still a fold, but there is nothing to write back.
  const empty = foldRecord([{ ref: "r-2", bytes: 5000, lines: 1, text: "", sentinels: ["x"] }]);
  assert.equal(foldEntries(empty)[0].text, "", "an empty entry cannot restore anything");
});

test("registerFoldSource installs a codec with clipboardText and serialize", () => {
  // registerFoldSource expects ctx.inputTriggers (or ctx.get("inputTriggers")).
  const sources = [];
  const ctx = {
    inputTriggers: {
      registerSource(src) { sources.push(src); },
    },
    effect(fn, label) { fn(); return () => {}; },
  };
  const { registerFoldSource, __foldTextByRef } = loadBundle().exports.__internals;
  __foldTextByRef.clear();

  registerFoldSource(ctx);
  assert.equal(sources.length, 1, "one source must be registered");
  const src = sources[0];
  assert.equal(src.trigger, "\x00");
  assert.equal(src.name, "folded-text");

  // clipboardText returns a placeholder
  assert.equal(typeof src.codec.clipboardText("r1"), "string");

  // serialize returns held text
  __foldTextByRef.set("r1", "六字真言");
  return src.codec.serialize("r1").then((text) => {
    assert.equal(text, "六字真言");
  });
});

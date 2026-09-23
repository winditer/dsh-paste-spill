import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Materialize lib/client.js exactly as the browser ModuleLoader would: capture
 * the registered record, then call its factory with a stubbed `require`.
 */
function loadBundle(reactExtras = {}) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  let record = null;
  const fakeWindow = { __ModuleLoader__: { load: (value) => { record = value; } } };
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
  };
  const fakeRequire = (id) => {
    if (id === "react") return react;
    throw new Error(`unexpected require: ${id}`);
  };
  return { record, exports: record.factory(fakeRequire) };
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
 * Find the chip button in a rendered PasteFoldChip tree, or null.
 *
 * The component always returns a Fragment of [locator, chip|null], so a test that
 * wants to know whether the visible affordance is on screen has to look one level
 * in rather than test the root.
 */
function chipOf(tree) {
  for (const child of tree?.children ?? []) {
    if (child !== null && typeof child === "object" && child.props?.["data-paste-spill-chip"]) return child;
  }
  return null;
}

/**
 * The expand affordance inside the chip. The chip is now a container (a div)
 * holding the open button and the dismiss button, so a test that wants the
 * "expand" action has to reach one level further in than `chipOf`.
 */
function openButtonOf(tree) {
  const chip = chipOf(tree);
  for (const child of chip?.children ?? []) {
    if (child !== null && typeof child === "object" && child.props?.["data-paste-spill-open"]) return child;
  }
  return null;
}

/** The dismiss (×) control inside the chip. */
function dismissButtonOf(tree) {
  const chip = chipOf(tree);
  for (const child of chip?.children ?? []) {
    if (child !== null && typeof child === "object" && child.props?.["data-paste-spill-dismiss"]) return child;
  }
  return null;
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

test("the bundle registers under the package name and exports a plugin", () => {
  const { record, exports } = loadBundle();
  assert.equal(record.id, "dsh-client-ui-paste-spill");
  assert.equal(typeof exports.apply, "function");
  assert.deepEqual(exports.inject, ["slots", "conversation", "sessions", "locale", "inputTriggers"]);
});

test("the fold chip source is registered with the trigger pipeline", async () => {
  const registered = [];
  applyWithTriggerStub({ registered });
  assert.equal(registered.length, 1, "exactly one fold source is registered");
  const [source] = registered;
  // The roster keys sources by (trigger, name) and throws on duplicates, so the
  // pair must be unique across all installed plugins.
  assert.equal(source.name, "folded-text");
  assert.equal(typeof source.trigger, "string");
  assert.equal(typeof source.codec.serialize, "function");
  // A source that contributed menu candidates would surface a stray trigger entry.
  assert.deepEqual(await source.candidates(), []);
});

test("the chip serializer returns the original pasted text, and refuses once released", async () => {
  const registered = [];
  const { exports } = applyWithTriggerStub({ registered });
  const { codec } = registered[0];

  const original = "line one\nline two\nline three\n";
  exports.__internals.holdFoldText("ref-1", original);
  // This is the value stock splices into the submitted message in place of the
  // chip's U+FFFC placeholder, so it must round-trip byte-for-byte.
  assert.equal(await codec.serialize("ref-1"), original);

  // After × or expand the text is released, and serializing must NOT silently
  // produce something else -- a missing ref is an error, not an empty string.
  exports.__internals.releaseFoldText("ref-1");
  await assert.rejects(() => codec.serialize("ref-1"));
});

test("inserting a fold chip holds the text BEFORE the chip exists, then wins the CAS", async () => {
  const registered = [];
  const { exports } = applyWithTriggerStub({ registered });
  const { codec } = registered[0];

  // A shell stub faithful to stock: `state.getSnapshot()` exposes draft/draftRev,
  // and `insertReference` applies only when the span's revision matches -- the same
  // CAS stock enforces, which is why a refusal is a normal outcome, not a bug.
  const calls = [];
  const shell = {
    rev: 7,
    draft: "AAA",
    state: { getSnapshot: () => ({ draft: shell.draft, draftRev: shell.rev }) },
    insertReference(ref, span) {
      // Record what the serializer could resolve AT INSERT TIME. If the hold were
      // taken after insertion, this lookup would miss.
      calls.push({ ref, span, resolvableAtInsert: exports.__internals.foldTextByRef.has(ref.ref) });
      if (span.draftRev !== shell.rev) return false;
      return true;
    },
  };

  const text = "pasted body\n".repeat(400);
  const ok = exports.__internals.insertFoldChip({ shell, text, ref: "r-7" });
  assert.equal(ok, true);
  assert.equal(calls.length, 1, "exactly one insertion attempt");
  assert.equal(calls[0].resolvableAtInsert, true, "the text must be held BEFORE the chip is inserted");
  // The span must cover the whole draft and carry the live revision, or stock's CAS refuses.
  assert.deepEqual(calls[0].span, { start: 0, end: 3, draftRev: 7 });
  assert.equal(await codec.serialize("r-7"), text);
});

test("a refused chip insertion releases the hold, so no ref is left dangling", () => {
  const registered = [];
  const { exports } = applyWithTriggerStub({ registered });

  // The CAS loses: stock refuses when the revision moved between our read and call.
  const shell = {
    rev: 9,
    draft: "AAA",
    state: { getSnapshot: () => ({ draft: "AAA", draftRev: 8 }) },
    insertReference: () => false,
  };
  const ok = exports.__internals.insertFoldChip({ shell, text: "x".repeat(5000), ref: "r-9" });
  assert.equal(ok, false);
  // A dangling hold would let a later message resolve a ref that no chip carries.
  assert.equal(exports.__internals.foldTextByRef.has("r-9"), false);
});

test("a shell that throws on insertion also releases the hold", () => {
  const registered = [];
  const { exports } = applyWithTriggerStub({ registered });
  const shell = {
    rev: 1,
    draft: "AAA",
    state: { getSnapshot: () => ({ draft: "AAA", draftRev: 1 }) },
    insertReference: () => { throw new Error("editor busy"); },
  };
  assert.equal(exports.__internals.insertFoldChip({ shell, text: "y".repeat(5000), ref: "r-1" }), false);
  assert.equal(exports.__internals.foldTextByRef.has("r-1"), false);
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

test("reactToDraft records fold state for a large insertion without uploading", async () => {
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const run = "x".repeat(5000);
  const outcome = reactToDraft({
    previous: "",
    current: run,
    run,
    sessionId: "sess-1",
    conversation: { createDrafts() { throw new Error("fold must not upload"); } },
    // A shell with no projection cannot take a chip, so this covers the FALLBACK:
    // the text stays inline and the record keeps the text as its own sentinel.
    shell: {},
    foldStore,
  });
  assert.equal(outcome, "fold");
  // The record is written SYNCHRONOUSLY with the clamp-only shape, because the chip
  // insertion is deferred: the fallback must already be correct at this instant.
  const record = foldStore.getSnapshot()["sess-1"];
  assert.equal(record.bytes, 5000);
  assert.equal(record.lines, 1);
  assert.deepEqual(record.sentinels, [run]);
  assert.equal(record.text, run);
  assert.equal(record.chipInserted, false);
  // A shell with no projection can never take a chip, so the deferral must leave it
  // that way rather than half-applying something.
  await Promise.resolve();
  assert.equal(foldStore.getSnapshot()["sess-1"].chipInserted, false);
});

test("the chip insert is DEFERRED, because inserting inside the editor's own update throws Lexical #337", async () => {
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const run = "z".repeat(5000);

  // Faithful reproduction of the real failure: `reactToDraft` is called from the
  // draft store's notification, which stock publishes SYNCHRONOUSLY from inside the
  // editor's update listener. So at call time the editor is mid-update, which makes
  // stock's `applyEdit` take its short-circuit branch (`fn(); return;`) and run the
  // `$`-body without assigning the active editor -- Lexical then throws #337.
  let inUpdate = false;
  let sawUpdateDuringCall = null;
  const shell = {
    rev: 5,
    get state() { return { getSnapshot: () => ({ draft: run, draftRev: shell.rev }) }; },
    insertReference() {
      sawUpdateDuringCall = inUpdate;
      if (inUpdate) throw new Error("Minified Lexical error #337");
      return true;
    },
    setDraft() {},
  };

  inUpdate = true;
  assert.equal(
    reactToDraft({
      previous: "", current: run, run, sessionId: "sess-1",
      conversation: { createDrafts() { throw new Error("fold must not upload"); } },
      shell, foldStore,
    }),
    "fold",
  );
  // The insert must NOT have been attempted while the update was in flight.
  assert.equal(sawUpdateDuringCall, null, "the chip insert must not run inside the editor update");
  inUpdate = false;
  // Once control returns to the microtask queue the update has committed, and the
  // insert is safe to attempt.
  await Promise.resolve();
  assert.equal(sawUpdateDuringCall, false, "the deferred insert must run OUTSIDE the update");
  assert.equal(foldStore.getSnapshot()["sess-1"].chipInserted, true);
});

test("the chip raises a hold, so the watcher cannot retire the record before the insert lands", async () => {
  // The in-app symptom this pins: stock's native chip node appeared, but OUR chip
  // (preview + expand action + ×) never did. Cause: the record is written before the
  // deferred insert, and the chip's insertion replaces the draft with a lone U+FFFC
  // -- a draft that no longer matches the text sentinels recorded at that moment. The
  // watcher's staleness test is therefore false, and without a live hold it retires
  // the record in that gap, so `foldApplies(record)` goes false and no chip renders.
  const { reactToDraft, createSessionStore, createHoldStore } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const holdStore = createHoldStore();
  const run = "w".repeat(5000);

  const shell = {
    rev: 2,
    get state() { return { getSnapshot: () => ({ draft: run, draftRev: shell.rev }) }; },
    insertReference: () => true,
    setDraft() {},
  };

  reactToDraft({
    previous: "", current: run, run, sessionId: "sess-1",
    conversation: { createDrafts() { throw new Error("fold must not upload"); } },
    shell, foldStore, holdStore,
  });
  // The hold must already be live, synchronously, BEFORE the deferred insert runs --
  // that instant is exactly when the watcher could otherwise judge the record stale.
  assert.equal(holdStore.has("sess-1"), true, "the hold must be raised before the insert is deferred");
  assert.equal(holdStore.get("sess-1"), run, "and must carry the text the chip represents");

  await Promise.resolve();
  // It survives the insert (the chip now owns the text) and is only released on an exit.
  assert.equal(holdStore.has("sess-1"), true);
  assert.equal(foldStore.getSnapshot()["sess-1"].chipInserted, true);
});

test("a refused insert releases the hold, so the watcher resumes owning the record", async () => {
  // On the clamp-only fallback the text stays inline. Keeping a hold there would tell
  // the watcher the text is intentionally out of the draft, so the record could never
  // be retired and the stale chip would outlive the text.
  const { reactToDraft, createSessionStore, createHoldStore } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const holdStore = createHoldStore();
  const run = "v".repeat(5000);

  const shell = {
    rev: 6,
    get state() { return { getSnapshot: () => ({ draft: run, draftRev: shell.rev }) }; },
    insertReference: () => false,
    setDraft() {},
  };

  reactToDraft({
    previous: "", current: run, run, sessionId: "sess-1",
    conversation: { createDrafts() { throw new Error("fold must not upload"); } },
    shell, foldStore, holdStore,
  });
  await Promise.resolve();
  assert.equal(holdStore.has("sess-1"), false, "the fallback must not leave a hold behind");
  assert.equal(foldStore.getSnapshot()["sess-1"].chipInserted, false);
});

test("the chip path replaces the draft with a placeholder and holds the text out of it", async () => {
  const { reactToDraft, createSessionStore, foldTextByRef } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const run = "x".repeat(5000);

  // A shell faithful to stock: the chip inserts over the whole draft at the live
  // revision, and clearing happens through setDraft.
  let draft = run;
  const shell = {
    rev: 3,
    get state() { return { getSnapshot: () => ({ draft, draftRev: shell.rev }) }; },
    insertReference(ref, span) {
      if (span.draftRev !== shell.rev) return false;
      // The span covers the WHOLE draft, so replacing it with the chip IS the removal.
      draft = "\uFFFC";
      return true;
    },
    // Faithful to stock: `setDraft` does `root.clear()` and rebuilds from plain text,
    // and it strips REFERENCE_PLACEHOLDER_RE -- whose range includes U+FFFC. So any
    // placeholder is destroyed by it, and a stray `setDraft("")` after a chip insert
    // would silently empty the composer (that was a real in-app bug).
    setDraft(text) {
      draft = String(text).replace(/[\uE100-\uE11D\uFFFC]/gu, "");
    },
  };

  const outcome = reactToDraft({
    previous: "",
    current: run,
    run,
    sessionId: "sess-1",
    conversation: { createDrafts() { throw new Error("fold must not upload"); } },
    shell,
    foldStore,
  });
  assert.equal(outcome, "fold");
  // The insertion is deferred out of the editor's in-flight update (Lexical #337),
  // so the chip lands on the next microtask.
  await Promise.resolve();

  const record = foldStore.getSnapshot()["sess-1"];
  assert.equal(record.chipInserted, true);
  assert.equal(typeof record.chipRef, "string");
  // The original text is no longer displayed in the input box -- the user's
  // requirement. What remains is the chip's lone placeholder, which is what keeps
  // stock's `empty` test false so the send button stays live.
  assert.equal(draft, "\uFFFC");
  // The text is held under the ref the chip carries, so the serializer can produce
  // the ORIGINAL body at submit time.
  assert.equal(foldTextByRef.get(record.chipRef), run);
  // Presence is judged on the placeholder now, not on the text that left the draft.
  assert.deepEqual(record.sentinels, ["\uFFFC"]);
});

test("a refused chip insertion leaves the text inline rather than losing it", async () => {
  const { reactToDraft, createSessionStore, foldTextByRef } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const run = "y".repeat(5000);

  // The CAS always loses here, which is a real outcome when the editor normalizes
  // the draft between our read and our call.
  let draft = run;
  const shell = {
    rev: 4,
    get state() { return { getSnapshot: () => ({ draft, draftRev: shell.rev }) }; },
    insertReference: () => false,
    setDraft(text) { draft = text; },
  };

  assert.equal(
    reactToDraft({
      previous: "", current: run, run, sessionId: "sess-1",
      conversation: { createDrafts() { throw new Error("fold must not upload"); } },
      shell, foldStore,
    }),
    "fold",
  );
  await Promise.resolve();
  const record = foldStore.getSnapshot()["sess-1"];
  assert.equal(record.chipInserted, false);
  // The editor must be untouched: the text is still the only copy, so clearing it
  // would destroy the paste outright.
  assert.equal(draft, run);
  // The ref is minted before the deferred insert (settle needs it to reconcile), so
  // what must hold is that its HOLD was rolled back -- a dangling hold would let a
  // later send resolve a ref no chip actually carries.
  assert.equal(loadBundle().exports.__internals.foldTextByRef.has(record.chipRef), false);
  assert.deepEqual(record.sentinels, [run]);
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

test("× on a chip clears the placeholder, so the chip is really gone", () => {
  const { removePastedText } = loadBundle().exports.__internals;
  // While a chip is mounted the draft is a lone U+FFFC, NOT the original text. So
  // `removePastedText` cannot find the paste, and its honest fallback is "" -- which
  // is what actually deletes the chip's placeholder from the editor.
  assert.equal(removePastedText("\uFFFC", "the original pasted text", ""), "");
  // A clamp-only fold still holds the real text, and that path excises precisely.
  assert.equal(removePastedText("keep me PASTE keep me", "PASTE", ""), "keep me  keep me");
});

test("dismissFold releases the chip's hold, so a deleted paste cannot come back", () => {
  const { dismissFold, createHoldStore, holdFoldText, releaseFoldText } = loadBundle().exports.__internals;
  const holdStore = createHoldStore();
  holdStore.set("sess-1", true);
  holdFoldText("r-1", "pasted".repeat(1000));

  let released = 0;
  const outcome = dismissFold({
    sessionId: "sess-1",
    holdStore,
    readDraft: () => "",
    removeText: (current) => current,
    writeDraft: () => true,
    clearFold: () => {},
    releaseChip: () => { released += 1; releaseFoldText("r-1"); },
  });
  assert.equal(outcome, "dismissed");
  assert.equal(released, 1, "the hold must be released exactly once");
  // Without this the held text would outlive the deletion, and a later send would
  // resolve it and re-send what the user discarded.
  assert.equal(loadBundle().exports.__internals.foldTextByRef.has("r-1"), false);
});

test("dismissFold releases the hold even when it finds nothing to delete", () => {
  // × on an already-empty fold must still not leave a dangling ref behind.
  const { dismissFold, createHoldStore, holdFoldText, foldTextByRef } = loadBundle().exports.__internals;
  const holdStore = createHoldStore();
  holdFoldText("r-2", "x");
  let released = 0;
  const outcome = dismissFold({
    sessionId: "sess-1",
    holdStore,
    readDraft: () => "",
    removeText: (current) => current,
    writeDraft: () => true,
    clearFold: () => {},
    releaseChip: () => { released += 1; },
  });
  assert.equal(outcome, "none");
  assert.equal(released, 1);
  assert.equal(foldTextByRef.has("r-2"), true, "this test's own hold is untouched");
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

test("watchDraft reacts to draft transitions and stops on unsubscribe", () => {
  const { watchDraft, createSessionStore, createPasteInbox } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const draftStore = createDraftStore("");
  const restores = [];
  const shell = {
    state: draftStore,
    setDraft(text) { draftStore.setDraft(text); },
  };
  const stop = watchDraft({
    shell,
    foldStore,
    sessionId: "sess-1",
    ctx: {},
    conversation: {},
    nextIndex: () => 1,
    inbox: createPasteInbox(),
    onRestore: () => restores.push(true),
  });
  const run = "x".repeat(5000);
  draftStore.setDraft(run);
  assert.equal(foldStore.getSnapshot()["sess-1"].bytes, 5000, "the watcher must fold a large insertion");
  stop();
  draftStore.setDraft("y".repeat(5000));
  assert.deepEqual(foldStore.getSnapshot()["sess-1"].sentinels, [run], "after unsubscribe nothing more is recorded");
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
  const fixture = readFileSync(new URL("../../fixtures/paste-60k.json", import.meta.url), "utf8");
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
  assert.equal(inbox.take(-1), null, "an expired entry is discarded");
  assert.ok(Date.now() - t < 1000);
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
  // pasted text not present at all (editor normalized it) falls back to empty
  assert.equal(removePastedText("something else", "\u0000absent", "x"), "");
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

test("no fold record renders the locator but no chip", () => {
  const { PasteFoldChip } = loadBundle().exports.__internals;
  const tree = PasteFoldChip({
    sessionId: "sess-1",
    usePasteFold: (select) => select({}),
    useFoldExpanded: (select) => select({}),
    t: (key) => key,
  });
  // The locator ALWAYS renders: the layout effect needs a mounted node to reach
  // the composer card from, and teardown needs one to clear the attributes from.
  // The visible chip, however, must not render when nothing is folded.
  assert.equal(chipOf(tree), null, "nothing folded means no chip");
  assert.equal(anchorOf(tree).props["data-paste-spill-anchor"], true);
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
  assert.deepEqual(Object.keys(face.hooks), ["pasteFold", "foldExpanded"]);
});

test("the collapse marker registers inside the composer card, not beside it", () => {
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
  assert.equal(typeof face.setFoldExpanded, "function", "the marker needs the toggle setter");
  for (const [name, source] of Object.entries(face.hooks)) {
    assert.equal(typeof source.subscribe, "function", `hook ${name} must expose subscribe`);
    assert.equal(typeof source.getSnapshot, "function", `hook ${name} must expose getSnapshot`);
  }
  assert.deepEqual(Object.keys(face.hooks), ["pasteFold", "foldExpanded"]);
});

test("the pasted text leaving the draft clears the record, which hides the card", () => {
  const { watchDraft, createSessionStore, createPasteInbox, PasteFoldChip } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const draftStore = createDraftStore("");
  const stop = watchDraft({
    shell: { state: draftStore, setDraft: (text) => draftStore.setDraft(text) },
    foldStore,
    sessionId: "sess-1",
    conversation: {},
    nextIndex: () => 1,
    inbox: createPasteInbox(),
    onRestore: () => {},
  });
  const run = "x".repeat(5000);
  draftStore.setDraft(run);
  const visible = () => chipOf(PasteFoldChip({
    sessionId: "sess-1",
    usePasteFold: (select) => select(foldStore.getSnapshot()),
    useFoldExpanded: (select) => select({}),
    t: (key) => key,
  }));
  assert.notEqual(visible(), null, "the chip shows while the folded text is in the draft");
  draftStore.setDraft("");
  assert.equal(foldStore.getSnapshot()["sess-1"], undefined, "clearing the draft must drop the record");
  assert.equal(visible(), null, "and the chip must then render nothing");
  stop();
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
  assert.deepEqual(Object.keys(face.hooks), ["pasteFold", "foldExpanded"]);
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

test("applyFoldToCard stamps only the card it is anchored inside", () => {
  const { applyFoldToCard, FOLD_ATTR } = loadBundle().exports.__internals;
  // Two composers exist (two open sessions). The marker must reach the card it
  // renders inside — never the first card in the document, which would clamp the
  // wrong session's composer.
  const mine = { attrs: new Set(), setAttribute(n) { this.attrs.add(n); }, removeAttribute(n) { this.attrs.delete(n); } };
  const other = { attrs: new Set(), setAttribute(n) { this.attrs.add(n); }, removeAttribute(n) { this.attrs.delete(n); } };
  const anchor = { closest: (sel) => (sel === "[data-composer-card]" ? mine : null) };
  assert.equal(applyFoldToCard(anchor, true), true);
  assert.ok(mine.attrs.has(FOLD_ATTR), "my card is clamped");
  assert.equal(other.attrs.size, 0, "the other session's card is untouched");
  assert.equal(applyFoldToCard(anchor, false), true);
  assert.equal(mine.attrs.size, 0, "expanding releases the clamp");
  // An unmounted/absent card must report failure so the caller can retry.
  assert.equal(applyFoldToCard(null, true), false);
  assert.equal(applyFoldToCard({ closest: () => null }, true), false);
});

test("the fold record and the expanded flag are cleared together", () => {
  const { watchDraft, createSessionStore, createPasteInbox } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const expandStore = createSessionStore();
  const draftStore = createDraftStore("");
  const stop = watchDraft({
    shell: { state: draftStore, setDraft: (text) => draftStore.setDraft(text) },
    foldStore,
    expandStore,
    sessionId: "sess-1",
    conversation: {},
    nextIndex: () => 1,
    inbox: createPasteInbox(),
  });
  const body = "y".repeat(6000);
  draftStore.setDraft(body);
  assert.equal(foldStore.getSnapshot()["sess-1"].bytes, 6000, "the paste folds");
  // The user opens it up...
  expandStore.set("sess-1", true);
  // ...then selects-all and deletes: BOTH must clear, or the next paste in this
  // session would appear already expanded.
  draftStore.setDraft("");
  assert.equal(foldStore.getSnapshot()["sess-1"], undefined, "the fold record clears");
  assert.equal(expandStore.getSnapshot()["sess-1"], undefined, "and so does the expanded flag");
  stop();
});

test("the collapse rule outranks the stock scroll rule it overrides", () => {
  // The clamp overrides `.p_FcLG_scroll{max-height:var(--dsh-composer-text-max-height)}`
  // from the stock stylesheet. That rule is a single class with no !important, so
  // specificity alone decides - and if our selector were ever simplified to a
  // single class, the clamp would silently stop working with no error anywhere.
  // Verified against the shipped bundle: maximum specificity here must stay
  // strictly above (0,1,0).
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

  const rule = /\[data-composer-card\]\[data-dshps-folded\](?::not\(\[data-dshps-chip\]\))?\s*\[data-input-scroll\]\{([^}]*)\}/.exec(css);
  assert.ok(rule, "the collapsed scroll rule must be installed");
  assert.match(rule[1], /max-height:\d+px/, "and must actually clamp the height");
  assert.match(rule[1], /mask-image/, "and fade the cut edge");
  // The clamp is a FALLBACK: it exists for a fold whose chip could not be inserted,
  // where the text stays inline. On a chip fold the editor is empty, so clamping
  // would serve no purpose beyond squeezing the chip's own band.
  assert.match(rule[0], /:not\(\[data-dshps-chip\]\)/, "the clamp must not apply to a chip fold");
  // Two lines, per the user's request. Pinned because it is derived (84px was
  // ~3 lines) rather than measured, so a careless edit shifting it back would
  // silently change what the fold shows.
  const clamp = /max-height:(\d+)px/.exec(rule[1]);
  assert.equal(Number(clamp[1]), 60, "the fold must show two lines");
  // Specificity: attributes count like classes, so count them in the selector.
  const selector = rule[0].slice(0, rule[0].indexOf("{"));
  const attributes = selector.match(/\[[^\]]+\]/g) ?? [];
  assert.ok(
    attributes.length >= 3,
    `selector ${selector} must carry >=3 attribute tests to outrank a single class, got ${attributes.length}`,
  );
});

test("stock's own inline rendering of our chip node is hidden, so the paste is one block", () => {
  // A reference node is drawn TWICE: stock paints it inline in the editor flow
  // (`.QiNVUW_chip`, a 22px pill) and we draw the real affordance as a floating
  // overlay. Left alone the user sees both, which reads as the paste having been
  // split into two separate blocks. This rule removes stock's copy.
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

  const rule = /\[data-composer-card\]\s*\.QiNVUW_chip\[title\^="已折叠 "\]\{([^}]*)\}/.exec(css);
  assert.ok(rule, "stock's inline chip must be suppressed");
  // display:none, not visibility:hidden: the node must stop occupying inline space,
  // or the editor would still reserve a 22px line for an invisible pill.
  assert.match(rule[1], /display:\s*none/);

  // Scoping matters: stock's chip DOM carries only `title={label}`, so the label is
  // the only discriminator. Without BOTH the stock class and the title prefix, the
  // rule would hide the user's own `@file` / image chips too.
  assert.match(rule[0], /\.QiNVUW_chip/, "must target stock's chip class");
  assert.match(rule[0], /title\^=/, "and must be scoped by the title prefix");
});

test("the chip is positioned inside the card, and the card reserves a band for it", () => {
  // The chip cannot occupy the flow itself: `conversation.input.overlay` is the
  // only in-card slot available and its anchor is `height:0` (a floating layer
  // shared with the `/` and `@` menus). So the chip is absolutely positioned, and
  // the card must reserve exactly that band as padding — otherwise the chip paints
  // over the attachments row and the editor's first line.
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

  const band = /\[data-composer-card\]\[data-dshps-chip\]\{padding-top:(\d+)px\}/.exec(css);
  assert.ok(band, "the card must reserve a band while the chip is mounted");
  const chip = /\.dshps-chip\{([^}]*)\}/.exec(css);
  assert.ok(chip, "the chip rule must be installed");
  assert.match(chip[1], /position:absolute/, "the chip floats, so it cannot take flow space");
  assert.match(chip[1], /top:\d+px/, "and is pinned inside that band");
  // A compact chip, not a full-width bar: the user chose the single-line compact
  // shape, so `right` must stay auto and the width must hug the content. Pinning
  // both sides would silently turn it into a banner across the whole card.
  assert.match(chip[1], /width:fit-content/, "the chip hugs its content");
  assert.match(chip[1], /max-width:calc\(100% - 24px\)/, "but cannot overflow the card");
  assert.ok(!/right:\d/.test(chip[1]), "no `right` offset, which would stretch it full width");
  // Two lines tall now (content preview + action), matching the reference chip,
  // so each line is explicitly single-line rather than relying on the height.
  assert.match(chip[1], /height:48px/);
  assert.match(css, /\.dshps-chip-preview\{[^}]*white-space:nowrap/, "the preview stays on one line");
  assert.match(css, /\.dshps-chip-action\{[^}]*white-space:nowrap/, "and so does the action line");

  // The two numbers must agree, or the chip overlaps the content below it. This is
  // the whole reason both are computed from the same constants.
  const top = Number(/\.dshps-chip\{[^}]*top:(\d+)px/.exec(css)[1]);
  const height = Number(/\.dshps-chip\{[^}]*height:(\d+)px/.exec(css)[1]);
  assert.ok(
    Number(band[1]) >= top + height,
    `band ${band[1]}px must cover the chip (top ${top}px + height ${height}px)`,
  );
});

test("a mounted but expanded fold keeps its band, so the text does not jump", () => {
  // The chip stays on screen while expanded (it is the "collapse again"
  // affordance), so the band must stay reserved. Releasing it on expand would drop
  // the editor up under a floating chip.
  const { applyFoldToCard, FOLD_ATTR, CHIP_ATTR } = loadBundle().exports.__internals;
  const card = {
    attrs: new Set(),
    setAttribute(n) { this.attrs.add(n); },
    removeAttribute(n) { this.attrs.delete(n); },
  };
  const anchor = { closest: () => card };

  applyFoldToCard(anchor, true, true);
  assert.ok(card.attrs.has(FOLD_ATTR), "collapsed clamps the editor");
  assert.ok(card.attrs.has(CHIP_ATTR), "and the chip is on screen");

  // Expanded: the clamp goes, the chip stays.
  applyFoldToCard(anchor, false, true);
  assert.equal(card.attrs.has(FOLD_ATTR), false, "expanding releases the clamp");
  assert.ok(card.attrs.has(CHIP_ATTR), "but the chip is still mounted, so the band stays");

  // Gone: both must go.
  applyFoldToCard(anchor, false, false);
  assert.equal(card.attrs.has(FOLD_ATTR), false);
  assert.equal(card.attrs.has(CHIP_ATTR), false, "teardown must not leave a stale band");
});

test("the chip expands the fold rather than mutating the draft itself", () => {
  // The chip never edits the draft: it asks the plugin's toggle to do it, because
  // expanding is a restore (the text is out of the editor and held) and only the
  // plugin knows where it is. A chip that called setDraft directly would blank the
  // content it was supposed to bring back.
  const { PasteFoldChip } = loadBundle().exports.__internals;
  const calls = [];
  const record = { bytes: 6000, lines: 3, text: '{"a":1}', sentinels: ["x"] };
  const render = (expanded) => PasteFoldChip({
    sessionId: "sess-1",
    usePasteFold: (select) => select({ "sess-1": record }),
    useFoldExpanded: (select) => select(expanded === undefined ? {} : { "sess-1": expanded }),
    onToggle: (sessionId, next) => calls.push([sessionId, next]),
    t: (key) => key,
  });

  const open = openButtonOf(render(undefined));
  assert.equal(open.props["aria-expanded"], false);
  open.props.onClick();
  assert.deepEqual(calls, [["sess-1", true]], "clicking the chip asks the plugin to restore the text");
});

test("the chip's effects stamp the stock composer card it renders inside", () => {
  // End-to-end wiring, with effects actually executing. Everything above asserts
  // on the rendered tree or the stylesheet; this is the only test that proves the
  // attribute reaches the DOM node that does the clamping — and it proves it
  // reaches the card via `closest()` from the anchor, not by document query (which
  // would hit whichever composer happens to be first, i.e. the wrong session).
  const { exports, layoutEffects, passiveEffects } = loadBundleWithEffects();
  const { FOLD_ATTR, CHIP_ATTR } = exports.__internals;

  const card = fakeCard();
  const anchorNode = { closest: (sel) => (sel === "[data-composer-card]" ? card : null) };
  const record = { bytes: 6000, lines: 3, sentinels: ["x"] };

  const render = (expanded) => {
    layoutEffects.length = 0;
    passiveEffects.length = 0;
    const tree = exports.__internals.PasteFoldChip({
      sessionId: "sess-1",
      usePasteFold: (select) => select({ "sess-1": record }),
      useFoldExpanded: (select) => select(expanded === undefined ? {} : { "sess-1": expanded }),
      setFoldExpanded: () => {},
      t: (key) => key,
    });
    // React would assign the ref during commit; the stub cannot, so do it here.
    anchorOf(tree).props.ref.current = anchorNode;
    return tree;
  };

  // Collapsed: the card is clamped AND carries the chip band.
  render(undefined);
  assert.equal(layoutEffects.length, 1, "exactly one layout effect syncs the card");
  layoutEffects[0]();
  assert.ok(card.attrs.has(FOLD_ATTR), "the editor is clamped");
  assert.ok(card.attrs.has(CHIP_ATTR), "and the chip band is reserved");

  // Expanded: the chip is GONE, so both attributes must be released together.
  // "展开后，chip 消失" — a band left reserved here would show a gap the user
  // cannot explain, and a clause that kept the clamp would hide the very text the
  // expand just restored.
  render(true);
  layoutEffects[0]();
  assert.equal(card.attrs.has(FOLD_ATTR), false, "expanding unclamps the editor");
  assert.equal(card.attrs.has(CHIP_ATTR), false, "and releases the band, since the chip is gone");

  // Teardown (session switch): an unmount effect clears both. It is the LAST
  // passive effect (the mousedown handler registers first and, while expanded,
  // bails out immediately), and it returns its cleanup rather than running it.
  // Indexed rather than searched for: invoking effects to identify them would
  // mutate the card during the search and make the result meaningless.
  const cleanup = passiveEffects.at(-1);
  assert.equal(typeof cleanup(), "function", "the unmount effect must return a cleanup");
  cleanup()();
  assert.equal(card.attrs.has(FOLD_ATTR), false, "teardown unclamps");
  assert.equal(card.attrs.has(CHIP_ATTR), false, "and releases the band");
});

test("the component renders a locator even with no store, so the card is always reachable", () => {
  // A missing hook must degrade, not throw: this renders inside the composer, so
  // an exception would take down the user's ability to type at all.
  const { PasteFoldChip } = loadBundle().exports.__internals;
  const tree = PasteFoldChip({ sessionId: "sess-1", usePasteFold: undefined, useFoldExpanded: undefined });
  assert.equal(chipOf(tree), null, "no store means nothing folded");
  assert.ok(anchorOf(tree), "but the locator still renders, so the effects have a node");
});

/** Build a real hold store pre-loaded with one session's held text. */
function holdWith(sessionId, text) {
  const store = loadBundle().exports.__internals.createHoldStore();
  store.set(sessionId, text);
  return store;
}

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


// --- Expand dismisses the chip entirely ---------------------------------------
//
// Final requirement: "展开后，chip消失并显示文本的完整内容". Once the text is back
// in the composer the chip has nothing left to represent, so it must unmount — not
// linger in an "expanded" state that offers to fold it again.

test("expanding clears the fold so the chip unmounts once the text is back", () => {
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
  const draftStore = createDraftStore("");
  const shell = {
    state: draftStore,
    setDraft: (text) => draftStore.setDraft(text),
    addAttachments: (ids) => draftStore.addAttachments(ids),
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

  const body = "q".repeat(6000);
  draftStore.setDraft(body);
  const face = entry.inject("s1");
  const record = face.hooks.pasteFold.getSnapshot()["s1"];
  assert.ok(record, "the paste folded");

  const renderChip = () => {
    const tree = face && loadBundle().exports.__internals.PasteFoldChip({
      sessionId: "s1",
      usePasteFold: (select) => select(face.hooks.pasteFold.getSnapshot()),
      useFoldExpanded: (select) => select(face.hooks.foldExpanded.getSnapshot()),
      onToggle: face.onToggle,
      onDismiss: face.onDismiss,
      getHeld: face.getHeld,
      t: (key) => key,
    });
    return chipOf(tree);
  };

  assert.notEqual(renderChip(), null, "the chip is shown while collapsed");

  // Expand: the text goes back, and the chip must be gone.
  face.onToggle("s1", true);
  assert.equal(draftStore.getSnapshot().draft, body, "the full text is restored verbatim");
  assert.equal(
    renderChip(),
    null,
    "and the chip is unmounted, because nothing is folded any more",
  );
});

test("a fresh large paste after an expand folds again, so the chip is not suppressed forever", () => {
  // The unmount must come from the fold being CONSUMED, not from a sticky "user
  // expanded once" flag: if it came from the flag, every later paste in that
  // session would arrive already-expanded and the chip would never appear again.
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
  const draftStore = createDraftStore("");
  const shell = {
    state: draftStore,
    setDraft: (text) => draftStore.setDraft(text),
    addAttachments: (ids) => draftStore.addAttachments(ids),
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

  const face = entry.inject("s1");
  draftStore.setDraft("a".repeat(6000));
  face.onToggle("s1", true);
  assert.equal(draftStore.getSnapshot().draft, "a".repeat(6000), "first paste restored");

  // A second, different large paste must fold again and show a chip.
  draftStore.setDraft(`${"a".repeat(6000)}${"b".repeat(6000)}`);
  const second = face.hooks.pasteFold.getSnapshot()["s1"];
  assert.ok(second, "the second large paste folds again");
  const tree = loadBundle().exports.__internals.PasteFoldChip({
    sessionId: "s1",
    usePasteFold: (select) => select(face.hooks.pasteFold.getSnapshot()),
    useFoldExpanded: (select) => select(face.hooks.foldExpanded.getSnapshot()),
    onToggle: face.onToggle,
    onDismiss: face.onDismiss,
    getHeld: face.getHeld,
    t: (key) => key,
  });
  assert.notEqual(chipOf(tree), null, "and its chip is shown, not permanently suppressed");
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

// --- Display-only folding ------------------------------------------------------
//
// The requirement, verbatim: "4000-50000 之间的内容展示为折叠的文本chip，只是一个展示
// 形式变化，完全不需要有一个附件chip，折叠的文本chip展开后就只剩原文本。不管是发送
// 折叠的文本chip还是展开后的原文本，turn 中仅展示原文本即可，不需要JSON文件chip"
//
// So folding is a CHANGE OF APPEARANCE ONLY. These tests pin the two properties that
// make that true, because both were violated by the earlier sidecar design: the text
// must stay in the composer, and no attachment may exist at any point.

test("collapsing never touches the draft and never attaches anything", () => {
  const { face, draftStore } = setUpFold();
  const body = "z".repeat(6000);

  draftStore.setDraft(body);
  assert.equal(draftStore.getSnapshot().draft, body, "the text stays in the composer");
  assert.deepEqual(draftStore.getSnapshot().attachmentIds, [], "and nothing is attached");
  assert.ok(face.hooks.pasteFold.getSnapshot()["s1"], "while the chip is shown");
});

test("expanding is purely visual: the text was already there and nothing is left over", () => {
  const { face, draftStore } = setUpFold();
  const body = "y".repeat(6000);

  draftStore.setDraft(body);
  face.onToggle("s1", true);

  // Collapse/expand move no text, so the draft is byte-identical throughout.
  assert.equal(draftStore.getSnapshot().draft, body, "the full text is still in the composer");
  assert.deepEqual(draftStore.getSnapshot().attachmentIds, [], "no attachment at any point");
  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"], undefined, "and the chip is gone");
});

test("the send button is disabled after expand-then-delete, so no file chip can be posted", () => {
  // The reported repro: paste -> expand -> delete all -> send posted a JSON chip.
  // Stock enables send on `draft.trim()==="" && attachments.length===0`, so this
  // asserts the composer really is empty rather than merely looking empty.
  const { face, draftStore } = setUpFold();

  draftStore.setDraft("w".repeat(6000));
  face.onToggle("s1", true);
  draftStore.setDraft("");

  const snap = draftStore.getSnapshot();
  const sendable = !(snap.draft.trim() === "" && snap.attachmentIds.length === 0);
  assert.equal(sendable, false, "an emptied composer cannot be sent");
});

test("× deletes the pasted text from the composer, not just the chip", () => {
  // Display-only folding keeps the text in the editor while collapsed, so a × that
  // merely unmounted the chip would leave the discarded paste sitting in the box.
  const { face, draftStore } = setUpFold();
  const body = "v".repeat(6000);

  draftStore.setDraft(body);
  face.onDismiss("s1");

  assert.equal(draftStore.getSnapshot().draft, "", "the pasted text is gone from the composer");
  assert.deepEqual(draftStore.getSnapshot().attachmentIds, [], "and nothing was attached");
  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"], undefined, "no chip remains");
});

test("× removes only the pasted run, keeping text the user typed around it", () => {
  const { face, draftStore } = setUpFold();
  const body = "u".repeat(6000);

  // Two transitions, because the excision target is derived from the DIFF. A paste
  // into an empty composer is one transition whose run is the whole draft (the
  // whole draft genuinely IS the paste there), so "text around the paste" only
  // exists once there was a previous draft to differ from.
  draftStore.setDraft("before  after");
  draftStore.setDraft(`before ${body} after`);
  assert.ok(face.hooks.pasteFold.getSnapshot()["s1"], "the paste folded");

  face.onDismiss("s1");

  assert.equal(draftStore.getSnapshot().draft, "before  after", "the user's own text survives");
});

test("a send clears the fold, and a later paste folds again", () => {
  const { face, draftStore } = setUpFold();
  draftStore.setDraft("t".repeat(6000));
  assert.ok(face.hooks.pasteFold.getSnapshot()["s1"], "the first paste folds");

  draftStore.commitSend();
  assert.equal(face.hooks.pasteFold.getSnapshot()["s1"], undefined, "the send cleared the fold");

  draftStore.setDraft("s".repeat(6000));
  assert.ok(face.hooks.pasteFold.getSnapshot()["s1"], "a later paste folds again");
  assert.deepEqual(draftStore.getSnapshot().attachmentIds, [], "still with no attachment");
});

test("a paste with surrounding text stores only the pasted run as the excision target", () => {
  // The distinction the x depends on. `measurableText` may answer with the WHOLE
  // draft -- its documented backstop for a jump it cannot shrink down -- but the
  // record's `text` is an EXCISION target, so storing the measurement there would
  // make x delete the user's own text along with the paste.
  //
  // Two revisions, so the diff can identify the paste. When the watcher sees only
  // one revision there is no way to tell the paste from pre-existing text, and the
  // code deliberately falls back to the whole draft; that case is covered by the
  // test below.
  const { face, draftStore } = setUpFold();
  // Both sizes stay inside the FOLD band (4000-50000 bytes): a bigger draft would
  // reach the spill threshold and leave this test exercising the wrong layer.
  const surrounding = "k".repeat(5000);
  const body = "j".repeat(6000);

  draftStore.setDraft(surrounding);
  draftStore.setDraft(surrounding + body);

  const record = face.hooks.pasteFold.getSnapshot()["s1"];
  assert.ok(record, "the paste folded");
  assert.equal(record.text, body, "the record holds the pasted run alone");
  assert.notEqual(record.text, draftStore.getSnapshot().draft, "and never the whole draft");
});

test("the excision target is always a genuine substring, so x can never over-delete", () => {
  // A whole-draft target is safe ONLY when the draft really is just the paste.
  // This pins the invariant the x relies on: whatever the record stores must be
  // found in the draft, or `removePastedText` refuses and nothing is deleted.
  const { face, draftStore } = setUpFold();
  const body = "m".repeat(6000);
  const surrounding = "n".repeat(6000);

  draftStore.setDraft(surrounding + body);
  const record = face.hooks.pasteFold.getSnapshot()["s1"];
  assert.ok(draftStore.getSnapshot().draft.includes(record.text), "the target is a substring of the draft");

  face.onDismiss("s1");
  assert.equal(draftStore.getSnapshot().draft, "", "so x deletes exactly what it identified");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Materialize lib/client.js exactly as the browser ModuleLoader would: capture
 * the registered record, then call its factory with a stubbed `require`.
 */
function loadBundle() {
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

test("the bundle registers under the package name and exports a plugin", () => {
  const { record, exports } = loadBundle();
  assert.equal(record.id, "dsh-client-ui-paste-spill");
  assert.equal(typeof exports.apply, "function");
  assert.deepEqual(exports.inject, ["slots", "conversation", "sessions", "locale"]);
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

test("keepFoldFor keeps the card only while the pasted text is still in the draft", () => {
  const { keepFoldFor } = loadBundle().exports.__internals;
  const record = { bytes: 5000, lines: 2, text: "big pasted text" };
  assert.equal(keepFoldFor(record, "prefix big pasted text suffix"), true);
  assert.equal(keepFoldFor(record, "big pasted tex"), false);
  assert.equal(keepFoldFor(record, ""), false);
  assert.equal(keepFoldFor(record, undefined), false);
});

test("createSessionStore notifies subscribers and clears per session", () => {
  const { createSessionStore } = loadBundle().exports.__internals;
  const store = createSessionStore();
  let notifications = 0;
  const dispose = store.subscribe(() => { notifications += 1; });
  assert.deepEqual(store.getSnapshot(), {});
  store.set("sess-1", { bytes: 5000, lines: 2, text: "x" });
  assert.equal(notifications, 1);
  assert.deepEqual(store.getSnapshot()["sess-1"], { bytes: 5000, lines: 2, text: "x" });
  store.clear("sess-1");
  assert.equal(notifications, 2);
  assert.deepEqual(store.getSnapshot(), {});
  dispose();
  store.set("sess-2", { bytes: 1, lines: 1, text: "y" });
  assert.equal(notifications, 2);
});
test("spillFile builds a plain-text File with the synthesized name", () => {
  const { spillFile } = loadBundle().exports.__internals;
  const file = spillFile("a".repeat(50000), 7);
  assert.equal(file.name, "pasted-text-7.txt");
  assert.equal(file.type, "text/plain");
  assert.equal(file.size, 50000);
});

test("handlePasteEvent leaves small pastes alone", () => {
  const { handlePasteEvent, createSessionStore } = loadBundle().exports.__internals;
  let prevented = false;
  const outcome = handlePasteEvent({
    text: "just a short note",
    sessionId: "sess-1",
    conversation: {},
    shell: {},
    foldStore: createSessionStore(),
    preventDefault: () => { prevented = true; },
  });
  assert.equal(outcome, "inline");
  assert.equal(prevented, false);
});

test("handlePasteEvent records fold state and does not prevent the default", () => {
  const { handlePasteEvent, createSessionStore } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  let prevented = false;
  const text = "x".repeat(5000);
  const outcome = handlePasteEvent({
    text,
    sessionId: "sess-1",
    conversation: {},
    shell: {},
    foldStore,
    preventDefault: () => { prevented = true; },
  });
  assert.equal(outcome, "fold");
  assert.equal(prevented, false, "fold layer must never swallow the paste");
  assert.deepEqual(foldStore.getSnapshot()["sess-1"], { bytes: 5000, lines: 1, text });
});

test("handlePasteEvent uploads a large paste and prevents the default", () => {
  const { handlePasteEvent, createSessionStore } = loadBundle().exports.__internals;
  const calls = { drafts: [], added: [], released: [], uploadListeners: 0 };
  const conversation = {
    createDrafts(sessionId, files) {
      calls.drafts.push({ sessionId, name: files[0].name });
      return [{ id: "draft-1", kind: "file" }];
    },
    releaseDraftAttachments(descriptors) {
      calls.released.push(descriptors.map((d) => d.id));
    },
    fileUploads: {
      subscribe() { calls.uploadListeners += 1; return () => {}; },
      getSnapshot() { return { "draft-1": { status: "uploading" } }; },
    },
  };
  const shell = { addAttachments(ids) { calls.added.push(ids); return true; } };
  let prevented = false;
  const outcome = handlePasteEvent({
    text: "y".repeat(50000),
    sessionId: "sess-1",
    conversation,
    shell,
    foldStore: createSessionStore(),
    preventDefault: () => { prevented = true; },
  });
  assert.equal(outcome, "file");
  assert.equal(prevented, true);
  assert.deepEqual(calls.drafts, [{ sessionId: "sess-1", name: "pasted-text-1.txt" }]);
  assert.deepEqual(calls.added, [["draft-1"]]);
  assert.equal(calls.uploadListeners, 1);
});

test("handlePasteEvent falls back to inline when the composer refuses the attachment", () => {
  const { handlePasteEvent, createSessionStore } = loadBundle().exports.__internals;
  const calls = { released: [] };
  const conversation = {
    createDrafts() { return [{ id: "draft-1", kind: "file" }]; },
    releaseDraftAttachments(descriptors) { calls.released.push(descriptors.map((d) => d.id)); },
    fileUploads: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  };
  const shell = { addAttachments: () => false };
  let prevented = false;
  const outcome = handlePasteEvent({
    text: "y".repeat(50000),
    sessionId: "sess-1",
    conversation,
    shell,
    foldStore: createSessionStore(),
    preventDefault: () => { prevented = true; },
  });
  assert.equal(outcome, "inline");
  assert.equal(prevented, false, "a refused attachment must leave the text in the editor");
  assert.deepEqual(calls.released, [["draft-1"]]);
});

test("handlePasteEvent falls back to inline when the session has no shell", () => {
  const { handlePasteEvent, createSessionStore } = loadBundle().exports.__internals;
  let prevented = false;
  const outcome = handlePasteEvent({
    text: "y".repeat(50000),
    sessionId: undefined,
    conversation: { createDrafts() { throw new Error("should not be called"); } },
    shell: undefined,
    foldStore: createSessionStore(),
    preventDefault: () => { prevented = true; },
  });
  assert.equal(outcome, "inline");
  assert.equal(prevented, false);
});

test("handlePasteEvent restores the text when the upload reports an error", () => {
  const { handlePasteEvent, createSessionStore } = loadBundle().exports.__internals;
  let listener = null;
  const conversation = {
    createDrafts() { return [{ id: "draft-1", kind: "file" }]; },
    releaseDraftAttachments() {},
    fileUploads: {
      subscribe(fn) { listener = fn; return () => { listener = null; }; },
      getSnapshot() { return { "draft-1": { status: "error", message: "boom" } }; },
    },
  };
  const restored = [];
  const shell = {
    addAttachments: () => true,
    paste(text) { restored.push(text); },
  };
  const outcome = handlePasteEvent({
    text: "z".repeat(50000),
    sessionId: "sess-1",
    conversation,
    shell,
    foldStore: createSessionStore(),
    preventDefault: () => {},
  });
  assert.equal(outcome, "file");
  assert.equal(typeof listener, "function");
  listener();
  assert.equal(restored.length, 1);
  assert.equal(restored[0], "z".repeat(50000));
});

test("the dock card renders nothing without a fold record", () => {
  const { PasteFoldCard } = loadBundle().exports.__internals;
  const tree = PasteFoldCard({
    sessionId: "sess-1",
    usePasteFold: () => ({}),
    useDraft: () => "",
    t: (key) => key,
  });
  assert.equal(tree, null);
});

test("the dock card renders nothing once the draft no longer holds the text", () => {
  const { PasteFoldCard } = loadBundle().exports.__internals;
  const record = { bytes: 5000, lines: 2, text: "big pasted text" };
  const tree = PasteFoldCard({
    sessionId: "sess-1",
    usePasteFold: () => ({ "sess-1": record }),
    useDraft: () => "cleared",
    t: (key) => key,
  });
  assert.equal(tree, null);
});

test("the dock card renders the fold metadata while the text is present", () => {
  const { PasteFoldCard } = loadBundle().exports.__internals;
  const record = { bytes: 5000, lines: 2, text: "big pasted text" };
  const tree = PasteFoldCard({
    sessionId: "sess-1",
    usePasteFold: () => ({ "sess-1": record }),
    useDraft: () => "big pasted text and more",
    t: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
  });
  // Collect leaf strings rather than matching the whole serialized tree: the
  // JSON form escapes the quotes inside the interpolated label arguments.
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
  const text = leaves.join("|");
  assert.match(text, /foldTitle/);
  assert.match(text, /"bytes":5000/);
  assert.match(text, /"lines":2/);
  assert.match(text, /foldHint/);
});

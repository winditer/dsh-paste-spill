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

/**
 * A minimal stand-in for the shell's InputState store: same shape the renderer
 * consumes (`getSnapshot`/`subscribe`) plus the `draftRev` counter the real
 * `compose()` publishes, which watchDraft uses to skip no-op notifications.
 */
function createDraftStore(initial) {
  let state = { draft: initial, draftRev: 0 };
  const listeners = new Set();
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDraft(text) {
      state = { draft: text, draftRev: state.draftRev + 1 };
      for (const listener of [...listeners]) listener();
    },
  };
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

test("reactToDraft records fold state for a large insertion without uploading", () => {
  const { reactToDraft, createSessionStore } = loadBundle().exports.__internals;
  const foldStore = createSessionStore();
  const run = "x".repeat(5000);
  const outcome = reactToDraft({
    previous: "",
    current: run,
    run,
    sessionId: "sess-1",
    conversation: { createDrafts() { throw new Error("fold must not upload"); } },
    shell: {},
    foldStore,
  });
  assert.equal(outcome, "fold");
  assert.deepEqual(foldStore.getSnapshot()["sess-1"], { bytes: 5000, lines: 1, text: run });
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
  assert.equal(foldStore.getSnapshot()["sess-1"].text, run, "after unsubscribe nothing more is recorded");
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
    shell: { state: draftStore, addAttachments: () => true, setDraft: (text) => draftStore.setDraft(text) },
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
      addAttachments: () => true,
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
  const { insertedRun, keepFoldFor } = loadBundle().exports.__internals;
  const cases = [
    ["", "x".repeat(5000)],
    ["pasted earlier ", "pasted earlier " + "y".repeat(5000)],
    ["head tail", "head " + "z".repeat(5000) + " tail"],
  ];
  for (const [before, after] of cases) {
    const run = insertedRun(before, after);
    assert.ok(run !== null, "each case is an insertion");
    assert.ok(after.includes(run), "the run must be a substring of the resulting draft");
    const record = { bytes: 5000, lines: 1, text: run };
    assert.equal(keepFoldFor(record, after), true, "so the card stays visible");
    assert.equal(keepFoldFor(record, before), false, "and hides once the text is gone");
  }
});

test("the dock card renders nothing without a fold record", () => {
  const { PasteFoldCard } = loadBundle().exports.__internals;
  const tree = PasteFoldCard({
    sessionId: "sess-1",
    usePasteFold: (select) => select({}),
    useDraft: (select) => select({ draft: "" }),
    t: (key) => key,
  });
  assert.equal(tree, null);
});

test("the dock card renders nothing once the draft no longer holds the text", () => {
  const { PasteFoldCard } = loadBundle().exports.__internals;
  const record = { bytes: 5000, lines: 2, text: "big pasted text" };
  const tree = PasteFoldCard({
    sessionId: "sess-1",
    usePasteFold: (select) => select({ "sess-1": record }),
    useDraft: (select) => select({ draft: "cleared" }),
    t: (key) => key,
  });
  assert.equal(tree, null);
});

test("the dock card renders the fold metadata while the text is present", () => {
  const { PasteFoldCard } = loadBundle().exports.__internals;
  const record = { bytes: 5000, lines: 2, text: "big pasted text" };
  const tree = PasteFoldCard({
    sessionId: "sess-1",
    usePasteFold: (select) => select({ "sess-1": record }),
    useDraft: (select) => select({ draft: "big pasted text and more" }),
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

test("the dock entry exposes store-shaped hooks, not plain functions", () => {
  const { apply } = loadBundle().exports;
  const capture = { entry: null, component: null, effects: [] };
  const stateStore = { getSnapshot: () => ({ draft: "hi" }), subscribe: () => () => {} };
  const documentStub = {
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
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
        register: (entry, component) => { capture.entry = entry; capture.component = component; },
      },
      conversation: { input: { shell: () => ({ state: stateStore }) } },
    };
    apply(ctx);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }

  assert.equal(capture.entry.name, "conversation.composer.dock");
  assert.equal(capture.entry.id, "paste-spill");
  assert.equal(typeof capture.component, "function");

  const face = capture.entry.inject("sess-1");
  // The renderer wraps every `hooks` value in useSyncExternalStore, so each one
  // MUST be a store. A plain function here silently never re-renders.
  for (const [name, source] of Object.entries(face.hooks)) {
    assert.equal(typeof source.subscribe, "function", `hook ${name} must expose subscribe`);
    assert.equal(typeof source.getSnapshot, "function", `hook ${name} must expose getSnapshot`);
  }
  assert.deepEqual(Object.keys(face.hooks).sort(), ["draft", "pasteFold"]);
  assert.equal(face.hooks.draft, stateStore, "the draft hook must be the shell's own state store");
});

test("the draft hook degrades to a harmless store when the session has no shell", () => {
  const { apply } = loadBundle().exports;
  let entry = null;
  const documentStub = {
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
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
      conversation: { input: { shell: () => { throw new Error("no binding"); } } },
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  const face = entry.inject("sess-1");
  assert.equal(typeof face.hooks.draft.getSnapshot, "function");
  assert.equal(face.hooks.draft.getSnapshot(), undefined);
});

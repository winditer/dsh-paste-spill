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
  assert.deepEqual(foldStore.getSnapshot()["sess-1"], { bytes: 5000, lines: 1, sentinels: [run] });
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

test("the dock card renders nothing without a fold record", () => {
  const { PasteFoldCard } = loadBundle().exports.__internals;
  const tree = PasteFoldCard({
    sessionId: "sess-1",
    usePasteFold: (select) => select({}),
    t: (key) => key,
  });
  assert.equal(tree, null);
});

test("the dock card renders from the fold record alone, without a draft hook", () => {
  const { PasteFoldCard } = loadBundle().exports.__internals;
  // The card deliberately has NO draft hook: the session binding's draft store is
  // materialized once and cached, so a binding born before the shell existed would
  // hand the card a permanently empty store and hide it forever. The watcher owns
  // clearing the record instead, so rendering depends on exactly one store.
  const record = { bytes: 5000, lines: 2, sentinels: ["big pasted text"] };
  const tree = PasteFoldCard({
    sessionId: "sess-1",
    usePasteFold: (select) => select({ "sess-1": record }),
    t: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
  });
  assert.notEqual(tree, null, "a record alone must be enough to render");
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
  const capture = { entry: null, component: null, effects: [], dock: null, overlay: null };
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
          if (entry.name === "conversation.input.dock") capture.dock = { entry, component };
          if (entry.name === "conversation.input.overlay") capture.overlay = { entry, component };
        },
      },
      conversation: { input: { shell: () => ({ state: stateStore }) } },
    };
    apply(ctx);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }

  assert.equal(capture.dock.entry.name, "conversation.input.dock");
  assert.equal(capture.dock.entry.id, "paste-spill");
  assert.equal(typeof capture.dock.component, "function");

  const face = capture.dock.entry.inject("sess-1");
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
  assert.deepEqual([...slots.keys()].sort(), ["conversation.input.dock", "conversation.input.overlay"]);
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
  const { watchDraft, createSessionStore, createPasteInbox, PasteFoldCard } = loadBundle().exports.__internals;
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
  const visible = () => PasteFoldCard({
    sessionId: "sess-1",
    usePasteFold: (select) => select(foldStore.getSnapshot()),
    t: (key) => key,
  });
  assert.notEqual(visible(), null, "the card shows while the folded text is in the draft");
  draftStore.setDraft("");
  assert.equal(foldStore.getSnapshot()["sess-1"], undefined, "clearing the draft must drop the record");
  assert.equal(visible(), null, "and the card must then render nothing");
  stop();
});

test("the dock inject never touches the session shell, so a missing binding cannot hide the card", () => {
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

test("REGRESSION: a 6000-byte paste folds even when the session binding predates the shell", () => {
  const { apply } = loadBundle().exports;
  // Reproduces the reported failure ("超过4000，低于50000，没有折叠") end to end:
  // the dock entry is injected for a session whose shell is ALREADY materialized,
  // then the draft changes. Because the card's hook is the plugin's own fold store
  // rather than the framework-cached session binding, the record reaches it.
  let entry = null;
  let component = null;
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
    addAttachments: () => true,
  };
  const ctx = {
    locale: { register: () => {} },
    effect: (fn) => { fn(); return () => {}; },
    slots: {
      inject: (_key, register) => register(),
      register: (e, c) => {
        // The plugin now registers twice (dock card + in-card collapse marker);
        // this test is about the CARD, so pick the dock by name rather than
        // whichever registration happened to land last.
        if (e.name === "conversation.input.dock") { entry = e; component = c; }
      },
    },
    sessions: { list: { getSnapshot: () => ({ current: "session-abc" }), subscribe: () => () => {} } },
    conversation: { input: { shell: () => shell } },
  };
  try {
    apply(ctx);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }

  // The dock asks for its hooks before any paste happens (the binding is made
  // once, cached, and reused) — the case that used to freeze an empty store.
  const face = entry.inject("session-abc");
  assert.equal(face.sessionId, "session-abc");

  const body = "x".repeat(6000);
  draftStore.setDraft(body);

  // The card must render from the store the dock already holds.
  const tree = component({
    sessionId: "session-abc",
    usePasteFold: (select) => select(face.hooks.pasteFold.getSnapshot()),
    useFoldExpanded: (select) => select(face.hooks.foldExpanded.getSnapshot()),
    t: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
  });
  assert.notEqual(tree, null, "the fold card must render for a 6000-byte paste");

  const leaves = [];
  const walk = (node) => {
    if (typeof node === "string") { leaves.push(node); return; }
    if (node === null || typeof node !== "object") return;
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  const text = leaves.join("|");
  assert.match(text, /foldTitle/, "the card shows in the composer dock");
  assert.match(text, /"bytes":6000/, "and reports the real pasted size");
  assert.equal(draftStore.getSnapshot().draft, body, "a fold never mutates the draft");
});

test("a blank session still gets a watcher, so the hero composer folds", () => {
  const { apply } = loadBundle().exports;
  // The reported failure happened in a BLANK session, where composer.dock never
  // renders. Two things must hold there: the watcher must install even though the
  // shell may not resolve on the first attempt, and the card must be registered on
  // the variant-independent slot.
  const slots = [];
  let entry = null;
  const draftStore = createDraftStore("");
  let shellCalls = 0;
  const hostStub = {
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
  };
  const previousDocument = globalThis.document;
  globalThis.document = hostStub;
  let rafPending = null;
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => { rafPending = fn; return 1; };
  try {
    apply({
      locale: { register: () => {} },
      effect: (fn) => { fn(); return () => {}; },
      slots: {
        inject: (key, register) => { slots.push(key); register(); },
        register: (e) => {
          if (e.name === "conversation.input.dock") entry = e;
        },
      },
      sessions: { list: { getSnapshot: () => ({ current: "session-blank" }), subscribe: () => () => {} } },
      // Throws the first time (scope not mounted yet), then resolves — the real
      // lazily-materialized-shell behaviour.
      conversation: {
        input: {
          shell: () => {
            shellCalls += 1;
            if (shellCalls === 1) throw new Error("scope not mounted");
            return { state: draftStore, setDraft: (text) => draftStore.setDraft(text) };
          },
        },
      },
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  }

  assert.deepEqual(
    slots.slice().sort(),
    ["conversation.input.dock", "conversation.input.overlay"],
    "the card goes on the variant-independent dock; the clamp marker inside the card",
  );
  assert.equal(entry.name, "conversation.input.dock");
  assert.equal(shellCalls, 1, "the first attempt legitimately fails");
  // The bounded retry schedule drives the second attempt, which succeeds.
  assert.equal(typeof rafPending, "function", "an unresolved shell must be retried, not abandoned");
  rafPending();
  assert.equal(shellCalls, 2, "the retry must re-attempt shell resolution");
  const body = "z".repeat(6000);
  draftStore.setDraft(body);
  // The proof that matters: the record reaches the store the dock card reads.
  const face = entry.inject("session-blank");
  const record = face.hooks.pasteFold.getSnapshot()["session-blank"];
  assert.ok(record !== undefined, "the retried watcher must fold the paste");
  assert.equal(record.bytes, 6000, "and measure it in UTF-8 bytes");
  assert.equal(draftStore.getSnapshot().draft, body, "a fold leaves the draft intact");
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

test("foldCollapsed: a fold collapses the composer until the user expands it", () => {
  const { foldCollapsed } = loadBundle().exports.__internals;
  const record = { bytes: 6000, lines: 5, sentinels: ["x"] };
  assert.equal(foldCollapsed(record, undefined), true, "a fresh fold starts collapsed");
  assert.equal(foldCollapsed(record, false), true);
  assert.equal(foldCollapsed(record, true), false, "expanded means the editor is not clamped");
  assert.equal(foldCollapsed(undefined, undefined), false, "nothing folded: composer untouched");
  assert.equal(foldCollapsed(null, false), false);
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

  const rule = /\[data-composer-card\]\[data-dshps-folded\]\s*\[data-input-scroll\]\{([^}]*)\}/.exec(css);
  assert.ok(rule, "the collapsed scroll rule must be installed");
  assert.match(rule[1], /max-height:\d+px/, "and must actually clamp the height");
  assert.match(rule[1], /mask-image/, "and fade the cut edge");
  // Specificity: attributes count like classes, so count them in the selector.
  const selector = rule[0].slice(0, rule[0].indexOf("{"));
  const attributes = selector.match(/\[[^\]]+\]/g) ?? [];
  assert.ok(
    attributes.length >= 3,
    `selector ${selector} must carry >=3 attribute tests to outrank a single class, got ${attributes.length}`,
  );
});

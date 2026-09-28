# dsh-paste-spill Implementation Plan

> **已被现行实现取代（2026-09-28）**：本文写的是"两个独立包 + CSS 钳制"的旧方案。现在是一个包 `dsh-paste-spill`（宿主半 + 浏览器半，一行 patch）、chip 是编辑器里的真实节点、rail 实测高度预留、监听器由 rail 自己安装。以 `README.md` 和 `dsh-paste-spill/` 里的代码为准；本文仅作历史记录。


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pasting large text into the DSH composer folds it into a card at ≥4,000 bytes and converts it into a real file attachment at ≥50,000 bytes, whose turn-tail card opens in the right sidebar.

**Architecture:** Two packages split by process boundary. The browser half installs a capture-phase `paste` listener; at ≥50,000 bytes it synthesizes a `File` and rides DSH's EXISTING attachment upload path (so the message carries a legal `file` block and `dsh-llm` automatically hands the model a read-only host path — zero model-side and zero session-format changes); at 4,000–49,999 bytes the text stays in the editor untouched and only a `conversation.composer.dock` card is added. The host half hooks `agent/inbox/inserted` to resolve `fileHostPath` from the message's `file` blocks, then appends `deliverables/presented` from an `agent/pre-step` observer so the stock, already-mounted `dsh-client-ui-deliverables` renders its clickable `PresentedFileCard` in the turn tail.

**Tech Stack:** Node.js 26 (`node --test` built in), Cordis plugin system (`apply(ctx)`), browser `window.__ModuleLoader__` factory bundles (plain JS + `require("react")`), no build step.

---

## ⚠️ AMENDMENT — read this before the tasks below

**This document was written before implementation and is now WRONG in three places. The tasks below are kept as the historical record; the shipped design is the authority.** Both bugs it caused were found only after shipping, and this amendment exists so nobody re-implements the broken version.

### 1. Detection is a DRAFT SUBSCRIPTION, not a capture-phase `paste` listener

The original design installed a `document` capture-phase `paste` listener and called `preventDefault()`. **This cannot work.** Verified in-app: the listener *was* installed and the draft *did* change, yet no `paste` event was ever delivered to it, so the store stayed empty. The editor is Lexical, whose `PASTE_COMMAND` runs in its own state machine; a capture listener neither reliably sees the event (delivery follows focus, and Lexical binds to the root element) nor suppresses the insertion via `preventDefault()`.

**Shipped:** the client subscribes to each session's `shell.state` draft store and diffs consecutive drafts (`insertedRun`). A one-slot inbox fed by `beforeinput`/`paste` observers supplies the authoritative pasted text for the cases a diff cannot measure (a paste that *replaces* similar text). Both feed `measurableText`.

### 2. The card lives on `conversation.input.dock`, NOT `conversation.composer.dock`

`composer.dock` is rendered only under

```js
variant === "composer" && input !== void 0 && sessionId !== void 0
```

and the variant is `"hero"` whenever `sessionId === void 0 || shellPhase === "blank" && ...`. So **in a blank session — exactly where a large paste is first tried — that slot never renders at all**, and no store contents can ever surface a card. This is what produced the reported "超过4000，低于50000，没有折叠" while the ≥50,000 attachment chip kept working (the input bar is outside that gate).

**Shipped:** registered on `conversation.input.dock` (stock occupants `todo` order 0, `queue` order 20; ours is order 10), which renders on `zone !== void 0` with no variant condition.

### 3. The card reads ONE store; the watcher owns the record's lifetime

The card originally needed two stores to agree — its fold record *and* the session's draft — and hid itself when `draft.includes(record.text)` was false. That draft hook is materialized **once per session binding and cached** (`standardProps` → WeakMap keyed by scope binding), so a binding created before the session's shell existed holds a permanently absent store: the card then read "the text is gone" and hid itself forever.

**Shipped:** the fold record is the card's only source. Records carry `sentinels` (the measured run, plus the whole draft when it differs) and the **draft watcher** — the one place that sees every revision — clears the record once none of the sentinels remain. Visibility is `foldApplies(record)` = record presence.

Also fixed while tracing: `reactToDraft` called `measurableText` without `previous`/`current`, so the whole-draft backstop never ran on the live path.

### Where the authoritative description lives

- `docs/superpowers/specs/2026-09-20-dsh-paste-spill-design.md` §0 — the two corrected findings, in full.
- `dsh-client-ui-paste-spill/lib/client.js` — the shipped code, with the reasoning in comments at each decision point.
- `dsh-client-ui-paste-spill/test/bundle.test.js` — 38 tests, including an end-to-end regression for the fold-card failure.

Tasks 2 and 6 below (which build the `paste` listener and the `composer.dock` registration) are **superseded** and must not be re-run.

## Global Constraints

- **Thresholds are UTF-8 BYTES, not characters.** Fold = 4000, spill = 50000. Count with `new TextEncoder().encode(text).byteLength`. The two layers are independent — never merge them into one switch.
- **Plugin names are bare, not scoped:** `dsh-paste-spill` (host) and `dsh-client-ui-paste-spill` (client). Third-party profile plugins in this environment use bare names (`dsh-temp-chat`, `dsh-message-rail`).
- **No build step.** This machine has NO esbuild and NO other bundler installed. `lib/client.js` is the shipped artifact AND the source, hand-authored in the `window.__ModuleLoader__.load({ id, factory })` format, exactly like `dsh-message-rail`. Never introduce a build dependency.
- **No JSX and no `import` statements inside `lib/client.js`.** Plain JS plus `require("react")` only.
- **Zero modifications to any stock package.** Never shadow `dsh-client-ui-conversation` or any other released package; never touch files under `/Applications/DSH Desktop.app/`.
- **Never append to the session from `agent/inbox/inserted` or from a `session/event` observer.** Both are inside (or synchronously downstream of) the append re-entrancy window. `agent/pre-step` is the only write point.
- **Never let a posting failure become a user-visible submission error.** All `session.append` calls in the host half are wrapped in try/catch that logs a warning and continues.
- **Never silently drop pasted text.** If the file path cannot be taken, the text must remain inline in the editor.
- Filename convention: synthesized pasted files are named `pasted-text-<n>.<ext>`; the host identifies them by that prefix. `callId` is `paste:<12 hex chars of the digest>`.
- Target environment: DSH Desktop `0.1.5-rc.2`, checkout `/Applications/DSH Desktop.app/Contents/Resources/app/`.

## Plan amendments to the design doc

Two facts discovered while verifying against source, which change the design doc's §4.2/§4.5/§12. Task 6 updates the doc to match.

1. **No build step is possible** — the design doc specified esbuild compiling `src/client.js` → `lib/client.js`. No bundler exists here. The plan hand-authors `lib/client.js` (the `dsh-message-rail` precedent). Consequence: the pure logic lives inside the bundle factory and is exported for tests as `__internals`.
2. **Upload failure IS observable** — design doc §12-1 asked how to observe an upload failure. Answer: `ctx.conversation.fileUploads` is a public snapshot store (`dsh-client-ui-conversation/lib/client.js:2842`, `:3015-3061`) whose entries move `uploading` → `ready` (`receiptId`, `file`) or `error` (`message`). So the conservative "always keep inline text" fallback is NOT needed: we `preventDefault()` and restore the text if and only if the upload reports `error`.

---

### Task 1: Host package — pure helpers for paste-file recognition and event payloads

**Files:**
- Create: `dsh-paste-spill/package.json`
- Create: `dsh-paste-spill/lib/helpers.js`
- Test: `dsh-paste-spill/test/helpers.test.js`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces: `PASTE_NAME_PREFIX` (`"pasted-text-"`), `isPasteAttachmentName(name: unknown): boolean`, `pasteAttachmentsOf(content: unknown): Array<{attachmentId: string, name: string, bytes: number}>`, `pasteCallId(attachmentId: string): string`, `presentedPayload(args: {turn: number, attachmentId: string, path: string, description: string}): {turn: number, callId: string, files: Array<{path: string, description: string}>}`.

- [ ] **Step 1: Create the host package manifest**

Create `dsh-paste-spill/package.json`:

```json
{
  "name": "dsh-paste-spill",
  "version": "0.1.0",
  "description": "DSH 入站大文本粘贴处理：turn tail 交付卡 + 右侧栏预览（宿主半）。",
  "license": "MIT",
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "cordis.patch.yml",
    "README.md"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2"
  }
}
```

Note: this task creates only `lib/helpers.js`; `lib/index.js` arrives in Task 2, and `cordis.patch.yml` in Task 6.

- [ ] **Step 2: Write the failing test**

Create `dsh-paste-spill/test/helpers.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASTE_NAME_PREFIX,
  isPasteAttachmentName,
  pasteAttachmentsOf,
  pasteCallId,
  presentedPayload,
} from "../lib/helpers.js";

test("PASTE_NAME_PREFIX is the documented literal", () => {
  assert.equal(PASTE_NAME_PREFIX, "pasted-text-");
});

test("isPasteAttachmentName only accepts our synthesized names", () => {
  assert.equal(isPasteAttachmentName("pasted-text-1.txt"), true);
  assert.equal(isPasteAttachmentName("pasted-text-12.md"), true);
  assert.equal(isPasteAttachmentName("notes.txt"), false);
  assert.equal(isPasteAttachmentName("my-pasted-text-1.txt"), false);
  assert.equal(isPasteAttachmentName(undefined), false);
  assert.equal(isPasteAttachmentName(42), false);
});

test("pasteAttachmentsOf extracts only well-formed file blocks with our prefix", () => {
  const content = [
    { type: "text", text: "hello" },
    { type: "file", attachment: { attachmentId: "sha256:aaaa", name: "pasted-text-1.txt", bytes: 51000 } },
    { type: "file", attachment: { attachmentId: "sha256:bbbb", name: "manual-upload.csv", bytes: 12 } },
    { type: "file", attachment: { name: "pasted-text-2.txt", bytes: 9 } },
    { type: "file" },
    { type: "file", attachment: { attachmentId: "sha256:cccc", name: "pasted-text-3.txt" } },
    null,
    "junk",
  ];
  const found = pasteAttachmentsOf(content);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { attachmentId: "sha256:aaaa", name: "pasted-text-1.txt", bytes: 51000 });
});

test("pasteAttachmentsOf tolerates non-array input", () => {
  assert.deepEqual(pasteAttachmentsOf(undefined), []);
  assert.deepEqual(pasteAttachmentsOf("nope"), []);
});

test("pasteCallId uses the first 12 hex chars of the digest", () => {
  assert.equal(pasteCallId("sha256:0123456789abcdef0123"), "paste:0123456789ab");
  assert.equal(pasteCallId("sha256:short"), "paste:short");
});

test("presentedPayload carries turn, callId and one file entry", () => {
  assert.deepEqual(
    presentedPayload({
      turn: 3,
      attachmentId: "sha256:0123456789abcdef0123",
      path: "/Users/x/.dsh/attachments/v1/files/01/0123/pasted-text-1.txt",
      description: "粘贴的大文本",
    }),
    {
      turn: 3,
      callId: "paste:0123456789ab",
      files: [{ path: "/Users/x/.dsh/attachments/v1/files/01/0123/pasted-text-1.txt", description: "粘贴的大文本" }],
    },
  );
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd dsh-paste-spill && node --test test/helpers.test.js`
Expected: FAIL — `Cannot find module '../lib/helpers.js'` (the module does not exist yet).

- [ ] **Step 4: Implement the helpers**

Create `dsh-paste-spill/lib/helpers.js`:

```js
/**
 * Pure helpers for the paste-spill host half. No cordis services, no I/O —
 * everything here is unit-testable in isolation.
 */

/** Filename prefix that marks a file as synthesized from a large paste. */
export const PASTE_NAME_PREFIX = "pasted-text-";

/** @returns true when the name is one of our synthesized pasted-text files. */
export function isPasteAttachmentName(name) {
  return typeof name === "string" && name.startsWith(PASTE_NAME_PREFIX);
}

/**
 * Pull the well-formed `file` blocks that came from a paste out of one message's
 * content. Anything malformed is skipped rather than thrown on: this runs on the
 * hot inbox path, and a bad block is not a reason to fail a user's submission.
 */
export function pasteAttachmentsOf(content) {
  if (!Array.isArray(content)) return [];
  const found = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type !== "file") continue;
    const attachment = block.attachment;
    if (attachment === null || typeof attachment !== "object") continue;
    if (typeof attachment.attachmentId !== "string" || attachment.attachmentId === "") continue;
    if (typeof attachment.name !== "string" || attachment.name === "") continue;
    if (typeof attachment.bytes !== "number") continue;
    if (!isPasteAttachmentName(attachment.name)) continue;
    found.push({
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      bytes: attachment.bytes,
    });
  }
  return found;
}

/**
 * Stable synthesized `callId` for a presented event. `deliverables/presented`
 * requires a non-empty callId, but a paste has no tool call to borrow one from,
 * so we derive one from the content digest. The `sha256:` prefix is dropped to
 * keep the id short and free of colons.
 */
export function pasteCallId(attachmentId) {
  const text = String(attachmentId);
  const digest = text.startsWith("sha256:") ? text.slice(7) : text;
  return `paste:${digest.slice(0, 12)}`;
}

/** Build the `deliverables/presented` payload for one pasted file. */
export function presentedPayload({ turn, attachmentId, path, description }) {
  return {
    turn,
    callId: pasteCallId(attachmentId),
    files: [{ path, description }],
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd dsh-paste-spill && node --test test/helpers.test.js`
Expected: PASS — 6 tests, 6 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
cd /Users/haifeng/Documents/dsh-paste-spill
git add dsh-paste-spill/package.json dsh-paste-spill/lib/helpers.js dsh-paste-spill/test/helpers.test.js
git commit -m "feat(paste-spill): host pure helpers for paste-file recognition"
```

---

### Task 2: Host plugin — inbox capture and the pre-step append

**Files:**
- Create: `dsh-paste-spill/lib/index.js`
- Test: `dsh-paste-spill/test/plugin.test.js`

**Interfaces:**
- Consumes: `pasteAttachmentsOf`, `presentedPayload` from Task 1 (`./helpers.js`).
- Produces: `apply(ctx)` and `inject` (`["sessionProjections"]`) — the host plugin entry points. The plugin registers listeners for `agent/inbox/inserted` and `agent/pre-step` on the given ctx.

**Why the two hooks are split:** `agent/inbox/inserted` fires at `dsh-agent-loop/lib/index.js:208`, immediately after the `agent/inbox/spliced` append at `:206` has returned — but the message's `file` blocks are only resolved from upload receipts upstream of that point. We record the host path there (a cheap, synchronous lookup) and defer the `session.append` to `agent/pre-step`, which runs after `turn/start` has been appended, satisfying the "event must be written after the turn is open" constraint. Writing from `session/event` is impossible: `dsh-session/lib/index.js:1181` throws on re-entry and the observer dispatch swallows it silently.

**Design note on `pending`:** keyed by `agent.session` in a `WeakMap` (the `dsh-plan-mode/lib/index.js:143` precedent). It is taken-and-deleted on the first `agent/pre-step` after capture, even when the boundary gate rejects, so a stale entry can never attach a card to a later turn.

- [ ] **Step 1: Write the failing test**

Create `dsh-paste-spill/test/plugin.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, inject } from "../lib/index.js";

/** Minimal fake of the cordis host ctx surface this plugin touches. */
function makeCtx({ hostPath = "/attachments/pasted-text-1.txt", boundary = { openTurnStartSeq: 5, lastTurn: 2 } } = {}) {
  const handlers = new Map();
  const appended = [];
  const session = {
    header: { id: "sess-1" },
    append(type, data) {
      appended.push({ type, data });
      return { type, data };
    },
  };
  const agent = { session };
  const ctx = {
    logger: { warn() {} },
    on(name, handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    get(name) {
      if (name !== "attachments") return undefined;
      return {
        fileHostPath() {
          return hostPath;
        },
      };
    },
    sessionProjections: {
      stateOf() {
        return boundary;
      },
    },
  };
  const fire = async (name, payload, next = async () => ({ kind: "continue" })) => {
    const handler = handlers.get(name);
    if (handler === undefined) throw new Error(`no handler for ${name}`);
    return await handler(payload, next);
  };
  return { ctx, agent, session, appended, fire, handlers };
}

const pastedMessage = (content) => ({ id: "m1", content });

test("declares only sessionProjections as an injected service", () => {
  assert.deepEqual(inject, ["sessionProjections"]);
});

test("inbox capture alone does not append to the session", async () => {
  const { ctx, agent, appended, fire } = makeCtx();
  apply(ctx);
  await fire("agent/inbox/inserted", {
    agent,
    message: pastedMessage([
      { type: "file", attachment: { attachmentId: "sha256:0123456789abcdef", name: "pasted-text-1.txt", bytes: 60000 } },
    ]),
  });
  assert.deepEqual(appended, []);
});

test("pre-step appends a presented event for a captured paste", async () => {
  const { ctx, agent, appended, fire } = makeCtx();
  apply(ctx);
  await fire("agent/inbox/inserted", {
    agent,
    message: pastedMessage([
      { type: "file", attachment: { attachmentId: "sha256:0123456789abcdef", name: "pasted-text-1.txt", bytes: 60000 } },
    ]),
  });
  await fire("agent/pre-step", { agent, signal: { aborted: false } });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, "deliverables/presented");
  assert.deepEqual(appended[0].data, {
    turn: 2,
    callId: "paste:0123456789ab",
    files: [{ path: "/attachments/pasted-text-1.txt", description: "粘贴的大文本" }],
  });
});

test("pre-step does not append twice for one capture", async () => {
  const { ctx, agent, appended, fire } = makeCtx();
  apply(ctx);
  await fire("agent/inbox/inserted", {
    agent,
    message: pastedMessage([
      { type: "file", attachment: { attachmentId: "sha256:0123456789abcdef", name: "pasted-text-1.txt", bytes: 60000 } },
    ]),
  });
  await fire("agent/pre-step", { agent, signal: { aborted: false } });
  await fire("agent/pre-step", { agent, signal: { aborted: false } });
  assert.equal(appended.length, 1);
});

test("pre-step appends nothing when no paste was captured", async () => {
  const { ctx, agent, appended, fire } = makeCtx();
  apply(ctx);
  await fire("agent/inbox/inserted", {
    agent,
    message: pastedMessage([{ type: "text", text: "just typing" }]),
  });
  await fire("agent/pre-step", { agent, signal: { aborted: false } });
  assert.deepEqual(appended, []);
});

test("pre-step drops the capture when the turn boundary gate rejects", async () => {
  const { ctx, agent, appended, fire } = makeCtx({ boundary: { openTurnStartSeq: null, lastTurn: 0 } });
  apply(ctx);
  await fire("agent/inbox/inserted", {
    agent,
    message: pastedMessage([
      { type: "file", attachment: { attachmentId: "sha256:0123456789abcdef", name: "pasted-text-1.txt", bytes: 60000 } },
    ]),
  });
  await fire("agent/pre-step", { agent, signal: { aborted: false } });
  await fire("agent/pre-step", { agent, signal: { aborted: false } });
  assert.deepEqual(appended, []);
});

test("pre-step does not append when fileHostPath resolves nothing", async () => {
  const { ctx, agent, appended, fire } = makeCtx({ hostPath: undefined });
  apply(ctx);
  await fire("agent/inbox/inserted", {
    agent,
    message: pastedMessage([
      { type: "file", attachment: { attachmentId: "sha256:0123456789abcdef", name: "pasted-text-1.txt", bytes: 60000 } },
    ]),
  });
  await fire("agent/pre-step", { agent, signal: { aborted: false } });
  assert.deepEqual(appended, []);
});

test("pre-step honors a rejecting decision and an aborted signal", async () => {
  const rejecting = makeCtx();
  apply(rejecting.ctx);
  await rejecting.fire("agent/inbox/inserted", {
    agent: rejecting.agent,
    message: pastedMessage([
      { type: "file", attachment: { attachmentId: "sha256:0123456789abcdef", name: "pasted-text-1.txt", bytes: 60000 } },
    ]),
  });
  await rejecting.fire("agent/pre-step", { agent: rejecting.agent, signal: { aborted: false } }, async () => ({ kind: "reject" }));
  assert.deepEqual(rejecting.appended, []);

  const aborted = makeCtx();
  apply(aborted.ctx);
  await aborted.fire("agent/inbox/inserted", {
    agent: aborted.agent,
    message: pastedMessage([
      { type: "file", attachment: { attachmentId: "sha256:0123456789abcdef", name: "pasted-text-1.txt", bytes: 60000 } },
    ]),
  });
  await aborted.fire("agent/pre-step", { agent: aborted.agent, signal: { aborted: true } });
  assert.deepEqual(aborted.appended, []);
});

test("an append failure is swallowed and never rejects the step", async () => {
  const { ctx, agent, session, fire } = makeCtx();
  session.append = () => {
    throw new Error("session append cannot reenter while another append is being published");
  };
  apply(ctx);
  await fire("agent/inbox/inserted", {
    agent,
    message: pastedMessage([
      { type: "file", attachment: { attachmentId: "sha256:0123456789abcdef", name: "pasted-text-1.txt", bytes: 60000 } },
    ]),
  });
  const decision = await fire("agent/pre-step", { agent, signal: { aborted: false } });
  assert.deepEqual(decision, { kind: "continue" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dsh-paste-spill && node --test test/plugin.test.js`
Expected: FAIL — `Cannot find module '../lib/index.js'`.

- [ ] **Step 3: Implement the host plugin**

Create `dsh-paste-spill/lib/index.js`:

```js
/**
 * dsh-paste-spill — host half.
 *
 * Watches inbox insertions for files synthesized from a large composer paste,
 * resolves each one's host path from the attachment store, and publishes a
 * `deliverables/presented` event so the stock deliverables plugin renders a
 * clickable card in the turn tail (whose click opens the right sidebar).
 *
 * Write timing is the whole trick here:
 *   - `agent/inbox/inserted` fires right after the inbox append returned, but the
 *     `file` blocks are already durable — we only RECORD there. Appending from a
 *     `session/event` observer instead would hit the re-entrancy guard at
 *     dsh-session/lib/index.js:1181, and that throw is swallowed log-only.
 *   - `agent/pre-step` runs after `turn/start` has been appended, so the turn the
 *     card belongs to is open and `turnBoundary.lastTurn` is readable.
 */
import { pasteAttachmentsOf, presentedPayload } from "./helpers.js";

/** Services reached by property access (see dsh-tool-present for the same shape). */
export const inject = ["sessionProjections"];

/** Description shown on the delivered-file card. */
const PASTE_DESCRIPTION = "粘贴的大文本";

/** @param ctx - host plugin context. */
export function apply(ctx) {
  /** Captured-but-not-yet-published pastes, keyed by the session object itself. */
  const pending = new WeakMap();

  ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    if (agent === undefined || agent.session === undefined) return;
    const attachments = pasteAttachmentsOf(message?.content);
    if (attachments.length === 0) return;
    const attachments2 = ctx.get("attachments");
    const resolved = [];
    for (const attachment of attachments) {
      let path;
      try {
        // Throws INVALID_ATTACHMENT_REF on a malformed ref, and returns
        // undefined when the store does not know this reference.
        path = attachments2?.fileHostPath(attachment);
      } catch (error) {
        ctx.logger.warn("dsh-paste-spill: failed to resolve host path: %o", error);
        continue;
      }
      if (typeof path !== "string" || path === "") continue;
      resolved.push({ attachmentId: attachment.attachmentId, path });
    }
    if (resolved.length === 0) return;
    const previous = pending.get(agent.session);
    pending.set(agent.session, {
      entries: [...(previous?.entries ?? []), ...resolved],
    });
  });

  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject" || signal?.aborted === true) return decision;
    if (agent === undefined || agent.session === undefined) return decision;
    const captured = pending.get(agent.session);
    if (captured === undefined) return decision;
    // Take-and-delete unconditionally: a capture must never survive into a later
    // turn and attach its card to the wrong one.
    pending.delete(agent.session);
    try {
      const boundary = ctx.sessionProjections.stateOf(agent.session, "turnBoundary");
      if (boundary === undefined || boundary.openTurnStartSeq === null || boundary.lastTurn < 1) return decision;
      for (const entry of captured.entries) {
        agent.session.append(
          "deliverables/presented",
          presentedPayload({
            turn: boundary.lastTurn,
            attachmentId: entry.attachmentId,
            path: entry.path,
            description: PASTE_DESCRIPTION,
          }),
        );
      }
    } catch (error) {
      // Posting a convenience event must never turn a good submission into an error.
      ctx.logger.warn("dsh-paste-spill: failed to append presented event: %o", error);
    }
    return decision;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dsh-paste-spill && node --test test/plugin.test.js`
Expected: PASS — 9 tests, 9 passing, 0 failing.

- [ ] **Step 5: Run the whole host suite**

Run: `cd dsh-paste-spill && node --test`
Expected: PASS — 15 tests, 15 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
cd /Users/haifeng/Documents/dsh-paste-spill
git add dsh-paste-spill/lib/index.js dsh-paste-spill/test/plugin.test.js
git commit -m "feat(paste-spill): host inbox capture and pre-step presented append"
```

---

### Task 3: Client package — bundle skeleton and the threshold logic

**Files:**
- Create: `dsh-client-ui-paste-spill/package.json`
- Create: `dsh-client-ui-paste-spill/lib/client.js`
- Create: `dsh-client-ui-paste-spill/lib/index.js`
- Test: `dsh-client-ui-paste-spill/test/bundle.test.js`

**Interfaces:**
- Consumes: nothing (self-contained bundle).
- Produces: the bundle exports `apply`, `inject`, and `__internals`. `__internals` = `{ FOLD_BYTES, SPILL_BYTES, utf8Bytes(text), decidePaste(text, foldBytes?, spillBytes?), pasteFileName(text, index), countLines(text), keepFoldFor(record, draft), createSessionStore() }`.
  - `decidePaste` returns `{action: "file" | "fold" | "inline", bytes: number}`.
  - `createSessionStore()` returns `{getSnapshot(): object, subscribe(fn): () => void, set(sessionId, record): void, clear(sessionId): void}`; `getSnapshot()` is a plain object mapping sessionId → `{bytes, lines, text}`.

**Why the pure logic is exported for tests:** with no bundler, `lib/client.js` is both the shipped artifact and the source. To keep the logic testable without duplicating it, the factory attaches the pure helpers to `module.exports.__internals`, and the test loads the bundle through a stubbed `window.__ModuleLoader__` and calls `factory(fakeRequire)`. This tests the exact bytes that ship.

- [ ] **Step 1: Create the client package manifest**

Create `dsh-client-ui-paste-spill/package.json`:

```json
{
  "name": "dsh-client-ui-paste-spill",
  "version": "0.1.0",
  "description": "DSH 入站大文本粘贴处理：折叠卡片 + 转文件（浏览器半）。",
  "license": "MIT",
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "cordis.patch.yml",
    "README.md"
  ],
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-session",
        "@deepseek-ai/dsh-client-locale"
      ],
      "immediately": true
    },
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

- [ ] **Step 2: Create the placeholder host half**

Create `dsh-client-ui-paste-spill/lib/index.js`:

```js
/**
 * dsh-client-ui-paste-spill node half. Pure UI plugin: the empty apply exists so
 * the package appears in the host loader (load and lifecycle follow the host);
 * the browser half ships via exports["./client"], discovered through the
 * package.json dsh.client declaration. Same shape as dsh-message-rail.
 */
export function apply() {}
```

- [ ] **Step 3: Write the failing test**

Create `dsh-client-ui-paste-spill/test/bundle.test.js`:

```js
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
    createElement: () => null,
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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd dsh-client-ui-paste-spill && node --test test/bundle.test.js`
Expected: FAIL — `ENOENT: no such file or directory ... lib/client.js`.

- [ ] **Step 5: Implement the bundle skeleton with the threshold logic**

Create `dsh-client-ui-paste-spill/lib/client.js`. Note the format: a
`window.__ModuleLoader__` factory bundle, plain JS plus `require("react")`, no
JSX and no `import`. Every side effect (CSS, listeners, slot registration) lives
inside `apply()` — never at module scope — so materializing the factory in a test
has no DOM dependencies.

```js
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

    exports.apply = function apply() {};
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
    };
    return module.exports;
  },
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd dsh-client-ui-paste-spill && node --test test/bundle.test.js`
Expected: PASS — 10 tests, 10 passing, 0 failing.

- [ ] **Step 7: Commit**

```bash
cd /Users/haifeng/Documents/dsh-paste-spill
git add dsh-client-ui-paste-spill/package.json dsh-client-ui-paste-spill/lib/index.js dsh-client-ui-paste-spill/lib/client.js dsh-client-ui-paste-spill/test/bundle.test.js
git commit -m "feat(paste-spill): client bundle skeleton with byte thresholds"
```

---

### Task 4: Client — the paste listener, the spill upload, and failure restore

**Files:**
- Modify: `dsh-client-ui-paste-spill/lib/client.js` (the `apply` export and its helpers)
- Modify: `dsh-client-ui-paste-spill/test/bundle.test.js` (append the new tests)

**Interfaces:**
- Consumes: `decidePaste`, `pasteFileName`, `countLines`, `createSessionStore`, `COMPOSER_SELECTOR` from Task 3's bundle internals.
- Produces: `exports.apply` now registers a document-level capture-phase `paste` listener and registers the dock slot. Adds `__internals.handlePasteEvent({event, sessionId, shell, conversation, foldStore, text, nextIndex})` — the testable core of the handler, separated from DOM plumbing — plus `__internals.uploadPaste({conversation, sessionId, shell, file, onFailure})` and `__internals.spillFile(text, index)`.

**Verified APIs this task depends on** (all from `dsh-client-ui-conversation/lib/client.js`):
- `ctx.conversation.createDrafts(sessionId, files)` → draft descriptors, upload starts immediately (`:2972`).
- `ctx.conversation.input.shell(sessionId)` → resident shell; throws when the session resolved no binding (`:13469`).
- shell `addAttachments(ids)` → `false` while the phase is `adjudicating`/`submitting`, else `true` (`:12776`).
- `ctx.conversation.releaseDraftAttachments(descriptors)` → aborts and unregisters (`:3149`).
- `ctx.conversation.fileUploads` → snapshot store; entry statuses `uploading` / `ready` / `error` (`:2842`, `:3015-3061`).

- [ ] **Step 1: Write the failing tests**

Append to `dsh-client-ui-paste-spill/test/bundle.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dsh-client-ui-paste-spill && node --test test/bundle.test.js`
Expected: FAIL — `handlePasteEvent is not a function` / `spillFile is not a function` (7 failing).

- [ ] **Step 3: Implement the paste handling**

In `dsh-client-ui-paste-spill/lib/client.js`, add these functions inside the factory, directly after `createSessionStore`:

```js
    /** Synthesize the File a spill paste becomes. */
    function spillFile(text, index) {
      return new File([text], pasteFileName(text, index), { type: "text/plain" });
    }

    /**
     * Start an upload for one synthesized paste file and watch it settle.
     * A file that never reaches `ready` leaves the submission stuck, so an
     * `error` restores the original text into the composer rather than losing it.
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
```

- [ ] **Step 4: Wire `apply` to register the listener and the dock slot**

Replace `exports.apply = function apply() {};` with:

```js
    /** @param ctx - client plugin context. */
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

      ctx.slots.inject("conversation.composer.dock", () =>
        ctx.slots.register(
          {
            name: "conversation.composer.dock",
            id: "paste-spill",
            order: 0,
            locale: NS,
            inject: (sessionId) => ({
              sessionId,
              hooks: { pasteFold: foldStore },
            }),
          },
          PasteFoldCard,
        ),
      );
    };
```

Also update the internals export to include the new functions:

```js
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
    };
```

Note: `PasteFoldCard` is defined in Task 5. Until then, `node --test` exercises `__internals` and `apply` only via the stub loader (which never calls `apply`), so this task's tests pass. Add a placeholder now so the file is coherent, and Task 5 replaces it:

```js
    /** Replaced by the real card in the next task. */
    function PasteFoldCard() {
      return null;
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd dsh-client-ui-paste-spill && node --test test/bundle.test.js`
Expected: PASS — 17 tests, 17 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
cd /Users/haifeng/Documents/dsh-paste-spill
git add dsh-client-ui-paste-spill/lib/client.js dsh-client-ui-paste-spill/test/bundle.test.js
git commit -m "feat(paste-spill): capture-phase paste listener with spill upload and failure restore"
```

---

### Task 5: Client — the dock fold card

**Files:**
- Modify: `dsh-client-ui-paste-spill/lib/client.js` (replace the `PasteFoldCard` placeholder)

**Interfaces:**
- Consumes: `keepFoldFor`, `createSessionStore`, `NS`, `zh`, `en` from Tasks 3–4; the dock entry's injected props `sessionId`, `usePasteFold` (from `hooks: { pasteFold: foldStore }`, auto-bound by the renderer to the `usePasteFold` prop via `standardHookPropName`), and `t`.
- Produces: the rendered fold card. No new exported surface.

**Verified API this task depends on:** `ctx.conversation.input.shell(sessionId)` returns a shell whose `state` is a snapshot store (`dsh-client-ui-conversation/lib/client.js:12687`); `getSnapshot().draft` is the live editor text (`:13064`). The dock slot is declared `{kind: "list", scope: "session"}` (`:16744`), and a session-scoped entry's `inject` receives the session id as its first argument (`dsh-client-ui-renderer/lib/client.js:333-340`).

- [ ] **Step 1: Write the failing test**

Append to `dsh-client-ui-paste-spill/test/bundle.test.js`:

```js
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
  const serialized = JSON.stringify(tree);
  assert.match(serialized, /foldTitle/);
  assert.match(serialized, /"bytes":5000/);
  assert.match(serialized, /"lines":2/);
  assert.match(serialized, /foldHint/);
});
```

These tests call the component directly as a function. That works because the
component takes its data through plain props (no state, no effects), so a direct
call is a faithful check of the returned element tree.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dsh-client-ui-paste-spill && node --test test/bundle.test.js`
Expected: FAIL — `PasteFoldCard` is not exported on `__internals`, so the first two tests throw and the third cannot match the copy.

- [ ] **Step 3: Implement the card**

In `dsh-client-ui-paste-spill/lib/client.js`, replace the placeholder with the real
component, and add `PasteFoldCard` to the `__internals` export:

```js
    /**
     * Dock card for the fold layer. It is a HINT, never a replacement: the full
     * text stays in the editor and is submitted verbatim, which is what keeps
     * slash-command and goal parsing identical to a plugin-free install.
     */
    function PasteFoldCard({ sessionId, usePasteFold, useDraft, t }) {
      const records = usePasteFold();
      const record = records?.[sessionId];
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
```

The card needs the live draft. Bind it in `apply` by extending the dock entry's
inject face:

```js
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
                useDraft: () => (shell === null ? "" : shell.state.getSnapshot().draft),
                hooks: { pasteFold: foldStore },
              };
            },
```

Then add the card's styles inside `apply`, next to the paste listener:

```js
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
```

Finally add `PasteFoldCard` to `exports.__internals`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dsh-client-ui-paste-spill && node --test test/bundle.test.js`
Expected: PASS — 20 tests, 20 passing, 0 failing.

- [ ] **Step 5: Verify the bundle parses as a script and declares no imports**

Run:
```bash
cd dsh-client-ui-paste-spill
node --check lib/client.js
grep -nE '^\s*(import|export) ' lib/client.js && echo "FOUND module syntax (bad)" || echo "OK: no top-level import/export"
```
Expected: `node --check` prints nothing (a syntax error would print a message and exit non-zero); the grep prints `OK: no top-level import/export`.

- [ ] **Step 6: Commit**

```bash
cd /Users/haifeng/Documents/dsh-paste-spill
git add dsh-client-ui-paste-spill/lib/client.js dsh-client-ui-paste-spill/test/bundle.test.js
git commit -m "feat(paste-spill): composer dock fold card"
```

---

### Task 6: Mount files, README, and the verification checklist

**Files:**
- Create: `dsh-paste-spill/cordis.patch.yml`
- Create: `dsh-client-ui-paste-spill/cordis.patch.yml`
- Create: `scripts/install-into-profile.sh`
- Create: `README.md`
- Modify: `docs/superpowers/specs/2026-09-20-dsh-paste-spill-design.md` (apply the two amendments recorded at the top of this plan)

**Interfaces:**
- Consumes: both packages' `package.json` and built artifacts from Tasks 1–5.
- Produces: loader rows, an idempotent installer, and user-facing docs. No code interface.

**Sandbox note:** `~/.dsh/profiles/desktop/` is NOT writable from the
`workspace-write` sandbox (verified: `touch` returns `Operation not permitted`).
The installer script is written here and run by the user outside the sandbox, or
by this session after an approved escalation.

- [ ] **Step 1: Create the host patch row**

Create `dsh-paste-spill/cordis.patch.yml`:

```yaml
# dsh-paste-spill bundle patch: one loader row per package half.
# The row `name` is this package itself, so the loader imports this package's
# host half. Semantics per dsh-app-boot applyEntryPatches: new rows use
# `insert:`; `id` is the fiber/entry identifier.
- insert:
    - id: paste-spill
      name: dsh-paste-spill
```

- [ ] **Step 2: Create the client patch row**

Create `dsh-client-ui-paste-spill/cordis.patch.yml`:

```yaml
# dsh-client-ui-paste-spill bundle patch. The row `name` is this package itself,
# so the web-modules scanner discovers the browser half through the
# `dsh.client` declaration in package.json.
- insert:
    - id: ui-paste-spill
      name: dsh-client-ui-paste-spill
```

- [ ] **Step 3: Create the installer script**

Create `scripts/install-into-profile.sh`:

```bash
#!/usr/bin/env bash
# Mount both paste-spill packages into the desktop profile.
#
# This must run OUTSIDE the agent's workspace-write sandbox: the profile lives at
# ~/.dsh/profiles/desktop, which that sandbox cannot write.
#
# Idempotent: re-running replaces the linked packages and re-writes the bundle
# list. `patchReload: live` in the profile means no restart is needed after this.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
NODE_MODULES="$PROFILE/node_modules"

HOST_PKG="dsh-paste-spill"
CLIENT_PKG="dsh-client-ui-paste-spill"

if [ ! -d "$PROFILE" ]; then
  echo "error: desktop profile not found at $PROFILE" >&2
  exit 1
fi

mkdir -p "$NODE_MODULES"
rm -rf "$NODE_MODULES/$HOST_PKG" "$NODE_MODULES/$CLIENT_PKG"
ln -s "$REPO_ROOT/$HOST_PKG" "$NODE_MODULES/$HOST_PKG"
ln -s "$REPO_ROOT/$CLIENT_PKG" "$NODE_MODULES/$CLIENT_PKG"
echo "linked: $NODE_MODULES/$HOST_PKG"
echo "linked: $NODE_MODULES/$CLIENT_PKG"

node - "$PROFILE/package.json" "$HOST_PKG" "$CLIENT_PKG" <<'NODE'
const fs = require("node:fs");
const [file, hostPkg, clientPkg] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
for (const name of [hostPkg, clientPkg]) {
  if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
}
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log("bundles:", pkg.dsh.profile.bundles.join(", "));
NODE

echo "done. If the GUI does not pick it up live, refresh the page."
```

Then make it executable:

```bash
chmod +x /Users/haifeng/Documents/dsh-paste-spill/scripts/install-into-profile.sh
```

- [ ] **Step 4: Verify the installer's JSON edit logic without touching the profile**

Run:
```bash
cd /Users/haifeng/Documents/dsh-paste-spill
tmp=$(mktemp -d)
printf '{"name":"dsh-profile-desktop","dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"],"patchReload":"live"}}}\n' > "$tmp/package.json"
node - "$tmp/package.json" dsh-paste-spill dsh-client-ui-paste-spill <<'NODE'
const fs = require("node:fs");
const [file, hostPkg, clientPkg] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
for (const name of [hostPkg, clientPkg]) {
  if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
}
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(pkg.dsh.profile.bundles.join(", "));
NODE
echo "--- result ---"
cat "$tmp/package.json"
rm -rf "$tmp"
```
Expected: the bundle list prints as `@deepseek-ai/dsh-base, dsh-paste-spill, dsh-client-ui-paste-spill`, the `patchReload: "live"` field survives, and the printed JSON ends with a newline.

- [ ] **Step 5: Write the README**

Create `README.md`:

````markdown
# dsh-paste-spill

DSH 的**入站**大文本粘贴处理：`dsh-spill` 管的是工具输出（出站），本插件补上方向相反的那一半。

| 层 | 阈值 | 行为 |
|---|---|---|
| 折叠层 | ≥ **4,000** UTF-8 字节 | 输入框出现"已折叠大文本"卡片，**全文留在草稿中**，提交时原样内联给模型 |
| 转文件层 | ≥ **50,000** UTF-8 字节 | 文本变成**真附件**落盘，消息里是 `file` 块；turn tail 出现可点卡片，点击在右侧栏预览 |

两层相互独立。4,000 是纯 UI 折叠，零语义变化；50,000 改变模型所见。

## 为什么折叠层不替换文本

卡片只是**提示**，不替换、不清空、不改写编辑器内容。这让 slash 命令与 goal 解析看到的草稿与没装插件时完全一致 —— Codex 的同类实现（#25346）因为把文本替换成附件，导致 `/goal` 判空。

## 架构

```
浏览器半  dsh-client-ui-paste-spill
  document 捕获阶段 'paste'
    ≥ 50000  → 合成 File → 既有附件上传链路 → 真 file 块；阻止默认插入
    4000+    → 全文照常进编辑器 + composer.dock 折叠卡片
                 │ 既有 remote 面 fileUploads.upload
                 ▼
宿主半    dsh-paste-spill
  agent/inbox/inserted  → 记录本轮粘贴附件的宿主路径（不 append）
  agent/pre-step        → session.append("deliverables/presented", {turn, callId, files})
                 │
                 ▼
  现成 dsh-client-ui-deliverables → turn tail 的 PresentedFileCard
                                  → 点击 → 右侧栏 documentpreview
```

**关键收益**：≥50,000 走真实附件上传，消息里就是合法 `file` 块，`dsh-llm` 的 `fileHandleText` **自动**给模型只读宿主路径。**零模型侧改动、零 session 格式改动、零 stock 包改动。**

## 安装

在本仓库根目录、于**沙箱外**执行：

```bash
./scripts/install-into-profile.sh
```

脚本会把两个包软链进 `~/.dsh/profiles/desktop/node_modules/` 并把包名加进该 profile 的 `dsh.profile.bundles`。profile 的 `patchReload: "live"` 会让改动即时生效；若 GUI 未自动拾取，刷新页面。

> 为什么必须在沙箱外：agent 的文件沙箱是 `workspace-write`，只能写本仓库，写不了 `~/.dsh/profiles/desktop/`。

## 卸载

```bash
rm ~/.dsh/profiles/desktop/node_modules/dsh-paste-spill \
   ~/.dsh/profiles/desktop/node_modules/dsh-client-ui-paste-spill
# 再从 ~/.dsh/profiles/desktop/package.json 的 dsh.profile.bundles 删掉这两个名字
```

## 测试

```bash
cd dsh-paste-spill && node --test
cd ../dsh-client-ui-paste-spill && node --test
```

## 设计文档与计划

- 设计：`docs/superpowers/specs/2026-09-20-dsh-paste-spill-design.md`
- 计划：`docs/superpowers/plans/2026-09-20-dsh-paste-spill.md`

## 已知限制

- 折叠卡片按会话跟踪**最近一次**大粘贴；连续多次大粘贴只显示最新的一次。
- 转文件层在附件上传失败时把原文补回编辑器（best-effort）；若补回失败，失败的附件卡仍带重试按钮，内容不会丢失。
- 交付卡带一个 `⌄` 菜单（"用默认应用打开 / 在 Finder 中显示"）。对粘贴文本属赘余，但它收在折叠菜单之后，且在宿主不可用时整体禁用。
````

- [ ] **Step 6: Apply the two design-doc amendments**

In `docs/superpowers/specs/2026-09-20-dsh-paste-spill-design.md`:

Replace the §4.5 build sentence — the doc currently says:

```markdown
- 构建：esbuild 打 `src/client.js` → `lib/client.js`（脚本模板取自 `dsh-temp-chat/scripts/build.mjs`，esbuild 0.24.2）。`src/client.js` 可以写 ESM + JSX，由 esbuild 转成工厂包。
```

with:

```markdown
- **无构建步骤**（已更正）：本机没有 esbuild 或任何打包器。`lib/client.js` **既是源码也是产物**，手写为 `window.__ModuleLoader__` 工厂包 —— 与 `dsh-message-rail` 的发布形态一致。纯逻辑在工厂内实现，并挂在 `module.exports.__internals` 上供 `node --test` 直接断言，避免"源码/产物两份、逻辑漂移"。
```

Replace §12 entirely with:

```markdown
## 12. 已解决：上传失败的观测方式

原设计把"如何观测上传失败"留作待验证项。**已核对源码，答案是可观测**：

`ctx.conversation.fileUploads` 是公开的 snapshot store（`dsh-client-ui-conversation/lib/client.js:2842`），每个草稿附件条目从 `uploading` 迁移到 `ready`（带 `receiptId`、`file`）或 `error`（带 `message`）（`:3015-3061`），并有 `getSnapshot()` / `subscribe()`。

因此**不需要**"始终保留内联原文"的保守降级：转文件层正常 `preventDefault()`，并订阅 `fileUploads`；仅在条目落到 `error` 时把原文补回编辑器（`shell.paste(text)`）。附件上传失败时 composer 本来就会显示带重试按钮的失败附件卡，内容不会丢失。

**另一项（捕获阶段 `preventDefault()`）**：实现照 DOM 标准做捕获阶段监听并 `preventDefault()`，需在真实 GUI 走一遍 §8 的端到端用例 1–3 确认。若发现 Lexical 仍插入文本，退回"不 preventDefault"的保守路线（代价：大文本双重表示）。
```

- [ ] **Step 7: Run both suites and verify the tree**

Run:
```bash
cd /Users/haifeng/Documents/dsh-paste-spill
(cd dsh-paste-spill && node --test) && (cd dsh-client-ui-paste-spill && node --test)
node --check dsh-client-ui-paste-spill/lib/client.js
ls dsh-paste-spill/cordis.patch.yml dsh-client-ui-paste-spill/cordis.patch.yml scripts/install-into-profile.sh README.md
```
Expected: both suites pass (15 + 20 tests), `node --check` is silent, and all four paths are listed.

- [ ] **Step 8: Commit**

```bash
cd /Users/haifeng/Documents/dsh-paste-spill
git add dsh-paste-spill/cordis.patch.yml dsh-client-ui-paste-spill/cordis.patch.yml scripts/install-into-profile.sh README.md docs/superpowers/specs/2026-09-20-dsh-paste-spill-design.md
git commit -m "chore(paste-spill): mount rows, installer, README, design amendments"
```

---

### Task 7: Mount into the live profile and verify end to end

**Files:**
- Modify (outside the sandbox): `~/.dsh/profiles/desktop/package.json`, `~/.dsh/profiles/desktop/node_modules/`

**Interfaces:**
- Consumes: `scripts/install-into-profile.sh` from Task 6 and both packages' artifacts.
- Produces: a live-mounted plugin. No code interface.

- [ ] **Step 1: Run the installer**

Run: `cd /Users/haifeng/Documents/dsh-paste-spill && ./scripts/install-into-profile.sh`
Expected: four lines of output ending with `done.`; the bundles list includes both package names.

**If the sandbox denies the write** (`Operation not permitted` or a `sandbox: file access denied` marker), retry this exact command once with `sandbox_permissions: "danger-full-access"` and the justification that the desktop profile lives outside the workspace. If the escalation is rejected, stop and hand the command to the user to run themselves — do not work around it.

- [ ] **Step 2: Verify the loader picked the packages up**

Run: `grep -n "paste-spill" ~/.dsh/profiles/desktop/package.json`
Expected: both `dsh-paste-spill` and `dsh-client-ui-paste-spill` appear in the bundles array.

- [ ] **Step 3: Confirm the client half actually materialized in the GUI**

In the DSH Web GUI at `http://127.0.0.1:43120`, open DevTools and check for the fold-card style tag and the registered slot:

```js
document.querySelector('style[data-plugin-css="dsh-paste-spill"]') !== null
```

Expected: `true` when a session with a composer is open. If `false`, the browser half did not materialize — check the console for an activation error (a missing or malformed `lib/client.js` fails loudly) and confirm the boot manifest lists the package.

- [ ] **Step 4: End-to-end case 1 — the fold layer**

In the composer, paste 5,000 bytes of plain text (e.g. run `node -e 'process.stdout.write("x".repeat(5000))' | pbcopy` then paste).
Expected: the full text appears in the editor **and** the "已折叠大文本 / Large text folded" card appears above the composer with the byte and line counts. Submit, then confirm the model received the text **inline** (not as a file).

- [ ] **Step 5: End-to-end case 2 — the spill layer**

Paste 60,000 bytes (`node -e 'process.stdout.write("y".repeat(60000))' | pbcopy`).
Expected: no inline text; an attachment chip named `pasted-text-<n>.txt` appears, then settles. After submitting, the user message carries a file block and a delivered-file card appears in the turn tail.

- [ ] **Step 6: End-to-end case 3 — the sidebar preview**

Click the delivered-file card in the turn tail.
Expected: the right sidebar opens the document preview on the stored file under `<DSH_HOME>/attachments/v1/files/...` — this simultaneously confirms that an outside-the-workspace absolute path is readable in the real GUI.

- [ ] **Step 7: End-to-end case 4 — sub-threshold pastes are untouched**

Paste 100 bytes.
Expected: text lands in the editor; no card, no attachment, no flicker.

- [ ] **Step 8: Record the outcome**

If all four cases pass, note that in the final report. If any fails, capture the console output and the observed behavior, then report the failure as a concrete blocker rather than claiming completion.

---

## Self-Review

**1. Spec coverage**

| Design doc requirement | Task |
|---|---|
| §2 byte thresholds 4000/50000, two independent layers | Task 3 (`FOLD_BYTES`, `SPILL_BYTES`, `decidePaste`) |
| §3 client capture → synthesized File → existing upload | Task 4 (`handlePasteEvent`, `uploadPaste`, `spillFile`) |
| §3 host capture + pre-step append | Task 2 |
| §4.1 capture-phase paste listener, file-paste passthrough, non-composer passthrough | Tasks 3 (`COMPOSER_SELECTOR`), 4 (`onDocumentPaste`) |
| §4.2 spill layer, no new remote surface, filename sanitization | Task 4 (`spillFile` → real upload; host `fileLeafName` sanitizes on save) |
| §4.2 upload-failure degradation | Task 4 (`fileUploads` subscription + `shell.paste` restore) |
| §4.3 fold card in `conversation.composer.dock`, text never replaced | Tasks 3 (`keepFoldFor`), 5 |
| §4.4 inject surfaces and current-session id | Task 3 (`exports.inject`), Task 4 (`onDocumentPaste`), Task 5 (`useDraft`) |
| §4.5 package shape, placeholder host half | Tasks 1, 3 |
| §5.1 inbox capture, host path, paste-only matching, no append in hook | Task 2 |
| §5.2 pre-step append, boundary gate, try/catch warn | Task 2 |
| §5.3 reuse of `deliverables/presented` | Task 2 (payload), Tasks 5–7 (rendering verified live) |
| §5.4 why not `session/event` | Task 2 (documented in the module header) |
| §6 install and mount | Tasks 6, 7 |
| §7 error/degradation table | Tasks 2 (append failures), 4 (upload failure, passthroughs) |
| §8 test strategy | Tasks 1–5 (unit), Task 7 (end to end) |
| §9 three SPEC corrections | Already in the design doc; no code |
| §10 scope exclusions | Global Constraints; no chip, no shadowing, no settings UI |
| §11 deliverables tree | Tasks 1–6 |
| §12 open questions | Task 6 Step 6 resolves both |

No gaps.

**2. Placeholder scan**

No "TBD", no "add appropriate error handling", no "similar to Task N". Every code step carries complete code. The one deliberate placeholder — `PasteFoldCard` returning `null` in Task 4 — is explicitly labeled as replaced in Task 5, and Task 4's tests never invoke it. `scripts/install-into-profile.sh` is complete and its JSON logic is executed against a temp file in Task 6 Step 4.

**3. Type consistency**

- `decidePaste` returns `{action, bytes}`; consistent across Tasks 3, 4, 5.
- `createSessionStore` exposes `getSnapshot/subscribe/set/clear`; consumed identically in Tasks 4 and 5.
- Record shape `{bytes, lines, text}` is set in Task 4 (`handlePasteEvent`) and read in Tasks 3 (`keepFoldFor`) and 5 (card) — same three keys everywhere.
- `handlePasteEvent` returns `"inline" | "fold" | "file"`; asserted against those exact strings in Task 4.
- `PASTE_NAME_PREFIX = "pasted-text-"` appears in the host helper (Task 1), the client bundle (Task 3), and the README (Task 6) — and Task 3's manifest comment names the host file it must stay in sync with.
- `pasteCallId` is defined once (Task 1) and used only via `presentedPayload`; Task 2 asserts the exact `paste:0123456789ab` value, matching Task 1's test.
- `exports.inject` is `["slots", "conversation", "sessions", "locale"]` in Task 3 and asserted in Task 3; `onDocumentPaste` uses `ctx.conversation` and `ctx.sessions`, and `apply` uses `ctx.locale` and `ctx.slots` — all declared.
---

## 执行记录（Task 7 完成后追加）

### 已完成的验证

| 项 | 证据 |
|---|---|
| 宿主纯逻辑 | `dsh-paste-spill`: `node --test` 15/15 |
| 浏览器半（含阈值、上传、失败回补、卡片、hook 形状） | `dsh-client-ui-paste-spill`: `node --test` 22/22 |
| 工厂包语法与纯净性 | `node --check lib/client.js` 通过；无顶层 `import`/`export` |
| 装载行合成 | 临时 profile `--dump-config` 输出含 `- id: paste-spill` / `- id: ui-paste-spill` 两行 |
| 两半与 profile 软链 | 两包的 `realpath` 指向本仓库；经软链 `import()` 与工厂加载均成功 |
| 服务名正确性 | `sessionProjections`（`dsh-session-projection:52`）、`conversation`（`ui-conversation:2857`）、`slots`（`ui-renderer:995`）、`sessions`（`ui-session:314`）、`locale`（`ui-locale:1378`）逐一核对存在 |
| CSS 变量 | 8 个 `--dsh-*` / `--dsw-*` 变量均在 stock CSS 中出现 |

### 实现期发现并修掉的两个真 bug

1. **hook 形状错误（严重）**。`inject()` 返回的 `hooks` 值会被渲染层包成 `observableHook` → `useSyncExternalStoreWithSelector`（`dsh-client-ui-renderer/lib/client.js:203-210`、`:341-347`）。原先把 `useDraft` 写成普通函数当 prop 传，导致：卡片**永远不订阅草稿**，文本清空后卡片不会消失；且 hook 调用形状与渲染层实际产出不符。已改为传 **store**（`{getSnapshot, subscribe}`），卡片内用选择器读取，并补了 2 个回归测试（断言 `face.hooks.*` 必须是 store）。
2. **CSS 几何偏宽**. 折叠卡原用 `calc(100% - side-clearance*2)`，而 stock dock 卡（`ui-conversation` TodoPanel）还要再扣 4 个 `--dsh-composer-dock-inset`。已对齐，避免比同栏 stock 卡宽出一圈。

### 未能在此环境完成的验证

**真实 GUI 的 4 个端到端用例未执行**：GUI 需重启才能拾取新的 `dsh.profile.bundles`（`dsh-app-boot/lib/index.js:240` 的 `bundlePatches` 只在启动时算一次；`patchReload: "live"` 只热重载补丁文件，不重读 bundles 列表）。此项需用户重启后手动确认。

### 2026-09-28 追加工作：会话相关性（"有的对话没有 chip"）

- 修复 1：`tryInstall` 每次重新解析 shell，shell 被替换时停旧订新（原来 `watchers.has(id)` 短路 → 死 watcher）。
- 修复 2：rail 始终挂载并把会话 id 写到 `[data-composer-card][data-dshps-session]`；粘贴 observer 据此
  把录制归到正确会话；inbox 按会话存/取（`take(sessionId)`），`unmapped` 只作兜底。
- 修复 3：`phase` 忙（`submitting`/`adjudicating`）时的插入拒绝 → 回滚且**重新武装**；
  新增 per-session armed retry（200ms × 5 分钟，定位 + phase 双条件，展开/×/发送/卸载即停）。
- 修复 4：折叠去重（`foldDeduped`），保证快路与保底路不会各折一次。
- 诊断：新增 `bySession.<id>`（`shellSwaps`/`watchInstalls`/`pasteBytes`/`verdict`/`chipDeferred`/
  `armed`/`armedPhase`/`armedTries`/`spillCleaned`/`sendCommitted`），读法见 README。
- 测试：99 → 100（新增 shell 替换、忙会话延迟折叠、粘贴按会话归属、一次粘贴只折一次）。
- 安装：`scripts/install-into-profile.sh` 重跑；profile 单一 bundle `dsh-paste-spill`，无 legacy 残留；
  仓库与安装副本 sha256 一致。

### 2026-09-28 回归（真机复现后修掉）

用户按修复后的版本复测：第一次 6K 出 chip，**第二次粘贴同一段 6K 没有 chip**。
诊断（`bySession.<id>`）直接指向原因：`verdict=fold`、`chipDeferred=inserted`、`foldDeduped=true`、
`lastTickLen=6019`（= 11 字节 chip footprint + 6008 原文）——第二次粘贴被"同文本去重"吞掉了。

- 根因：merged-2 引入的"折叠去重"用**文本**判断"这次粘贴是否已经折过"。
- 修法：去重改为**按插入身份**（录制带 `pasteId`，`armRetry`/`spillAttemptedPastes` 全部按键身份；
  删除文本比较）。同一段文本第二次粘贴会正常折出第二枚 chip。
- 新增回归测试：`the SAME text pasted twice makes two chips`；
  并把 `one paste folds exactly once with BOTH triggers armed` 改为真正同时驱动两条路。
- 测试 101 → 102；BUILD_REV merged-3 → merged-4（随后 merged-5：把 spill 记账改成有上限的按 pasteId 列表）。

### 2026-09-28 第二轮：独立评审 → 四条静默丢文本路径

用户复测后（第一次有 chip、第二次没有）先修掉了"按文本去重"的回归，随后把这一层交给独立评审
（只读、带 probe）复查。评审给出 3 CRITICAL + 2 HIGH，全部在真机前用探针复现，全部修复：

- **C1** 转文件清理把"定位不到"当成空草稿 → CRLF 粘贴会删掉用户自己打的字（probe p3）。
- **C2** 无会话录制可被任何会话领走 → A 的粘贴被 B 建成附件、B 的草稿被清（probe p5）。
- **C3** 离开再进会话：镜像草稿里 chip 只剩 label，旧代码释放持有文本 → 原文丢失、发送 label（probe p8）。
- **H1** 保底重试只认光标 → 粘完再打字就放弃折叠（probe p6，正是"有的对话没有 chip"的形态）。
- **H2** `spillInFlight` 登记时机 → 已 ready 的上传把会话永久标记，之后不再折叠（probe p4b）。

另修 M1（watcher 无上限、spill 记账不随插件卸载清空）与 M3（`normalizations()` 缺少编辑器的
占位符剥离）；M2（"记录被撤销但 chip 已落地"）做了保守加固：写得掉就写掉并释放，写不掉就
**保留持有文本**（宁可留一枚看不见的 chip，也不能让 serialize 退化成 label）。

验证：`node --test` 107 个测试全绿；五条新回归测试**逐条做过"回退即红"验证**；
评审的 probe p1/p3/p4b/p5/p6/p8/p9/p10 在最终构建上重跑全部通过。
BUILD_REV merged-5 → merged-6。

### 2026-09-28 第三轮：真机序列"6K → 60K"

用户报"先粘贴6K，后粘贴60K，输入框会出现：已折叠 5.9 KB"。诊断（`bySession`）显示
`chipCount=1 / chipDeferred=inserted / uploadStartBytes=60154 / spilledTextRemoved=true`：
chip 插入过，60K 也真的转了文件，但清理原文用了 `setDraft` → 整篇重写抹掉 chip 节点。

- 修法：`removePastedRunInPlace()` —— `pastedRunSpan()` 定位粘贴段，`actions.insertText("", span)`
  就地写空；应用路径不再有 `setDraft` 回退；定位不到就保持原文（`spillCleanupSkipped`）。
- 回归测试：`folding 6K then spilling 60K keeps the chip, and the label never becomes the text`
  （把清理换回 `setDraft` 立即变红）。
- 测试 107 → 108；BUILD_REV merged-6 → merged-7。

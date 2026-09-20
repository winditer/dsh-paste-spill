import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, inject } from "../lib/index.js";

/**
 * Minimal fake of the cordis host ctx surface this plugin touches.
 *
 * `hostPath` is read with an explicit `in` check rather than a destructuring
 * default, because a default would also fire for an explicitly-passed
 * `undefined` — which is exactly the case one test needs to exercise.
 */
function makeCtx(options = {}) {
  const hostPath = "hostPath" in options ? options.hostPath : "/attachments/pasted-text-1.txt";
  const boundary = options.boundary ?? { openTurnStartSeq: 5, lastTurn: 2 };
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
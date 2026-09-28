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

/**
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  /** Captured-but-not-yet-published pastes, keyed by the session object itself. */
  const pending = new WeakMap();

  ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    if (agent === undefined || agent.session === undefined) return;
    const attachments = pasteAttachmentsOf(message?.content);
    if (attachments.length === 0) return;
    const store = ctx.get("attachments");
    const resolved = [];
    for (const attachment of attachments) {
      let path;
      try {
        // Throws INVALID_ATTACHMENT_REF on a malformed ref, and returns
        // undefined when the store does not know this reference.
        path = store?.fileHostPath(attachment);
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
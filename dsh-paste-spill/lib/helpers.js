/**
 * Pure helpers for the paste-spill host half. No cordis services, no I/O —
 * everything here is unit-testable in isolation.
 */

/** Filename prefix that marks a file as synthesized from a large paste. */
export const PASTE_NAME_PREFIX = "pasted-text-";

/**
 * @returns true when the name is a SPILLED paste — the one kind that earns a card.
 *
 * There is no fold-sidecar prefix any more: 4000-50000 byte pastes fold by
 * CLAMPING the composer's appearance and leave their text in the editor, so they
 * attach no file at all and can never appear in a turn as one.
 */
export function isSpillAttachmentName(name) {
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
    // Spilled pastes only: a fold sidecar is carried, never presented (see
    // isSpillAttachmentName for why the two are separated).
    if (!isSpillAttachmentName(attachment.name)) continue;
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

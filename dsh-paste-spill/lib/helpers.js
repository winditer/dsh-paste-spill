/**
 * Pure helpers for the paste-spill host half. No cordis services, no I/O —
 * everything here is unit-testable in isolation.
 */

/** Filename prefix that marks a file as synthesized from a large paste. */
export const PASTE_NAME_PREFIX = "pasted-text-";

/**
 * Filename prefix for the FOLD sidecar.
 *
 * A 4000-50000 byte paste folds: the composer is emptied and the text rides a
 * sidecar attachment. Its card is deliberately hidden in the composer (the user
 * wants only the chip), which is why it needs a name distinct from
 * `PASTE_NAME_PREFIX` — otherwise the hide rule could not be scoped to it without
 * also hiding a spilled paste's card. It is still one of ours, so it must still be
 * recognized here or the turn-tail card would silently stop appearing.
 */
export const FOLD_NAME_PREFIX = "folded-text-";

/** @returns true when the name is one of our synthesized large-paste files. */
export function isPasteAttachmentName(name) {
  if (typeof name !== "string") return false;
  return name.startsWith(PASTE_NAME_PREFIX) || name.startsWith(FOLD_NAME_PREFIX);
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
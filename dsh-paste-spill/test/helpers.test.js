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
  // The fold sidecar uses its own prefix (the composer hides that card by name),
  // but it is still our synthesized file and must still be recognized -- otherwise
  // the turn-tail card would silently stop appearing for every folded paste.
  assert.equal(isPasteAttachmentName("folded-text-1.txt"), true);
  assert.equal(isPasteAttachmentName("folded-text-12.json"), true);
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
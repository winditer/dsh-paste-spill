import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASTE_NAME_PREFIX,
  isSpillAttachmentName,
  pasteAttachmentsOf,
  pasteCallId,
  presentedPayload,
} from "../lib/helpers.js";

test("the spill prefix is the documented literal", () => {
  assert.equal(PASTE_NAME_PREFIX, "pasted-text-");
});

test("only a spilled paste is accepted, and never a stranger", () => {
  assert.equal(isSpillAttachmentName("pasted-text-1.txt"), true);
  assert.equal(isSpillAttachmentName("pasted-text-12.md"), true);

  for (const name of ["notes.txt", "my-pasted-text-1.txt", undefined, 42]) {
    assert.equal(isSpillAttachmentName(name), false, `${name} is not a spill`);
  }
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
test("only a spilled paste is collected, so a fold sidecar gets no timeline card", () => {
  // A fold's sidecar must never produce a `deliverables/presented` card. The user
  // wants the fold to be JUST the composer chip: the sidecar exists only to carry
  // the text through submit, and a big card in the timeline for a paste the user
  // already saw as a chip is exactly the duplicate being removed.
  //
  // The >=50000 spill is the opposite: there the real attachment IS the feature,
  // and its card is what the user clicks to preview.
  const blocks = [
    {
      type: "file",
      attachment: { attachmentId: "sha256:aa", name: "pasted-text-1.json", bytes: 60154 },
    },
    {
      type: "file",
      attachment: { attachmentId: "sha256:bb", name: "folded-text-2.json", bytes: 6008 },
    },
  ];
  const found = pasteAttachmentsOf(blocks);
  assert.equal(found.length, 1, "exactly one of the two is collected");
  assert.equal(found[0].name, "pasted-text-1.json", "the spilled paste is the one that gets a card");
  assert.equal(found[0].attachmentId, "sha256:aa");
});

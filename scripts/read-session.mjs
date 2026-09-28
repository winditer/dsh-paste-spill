#!/usr/bin/env node
// Decompress one DSH session transcript and print selected records.
//
// Why a script: the transcript is `session.v4.jsonl.zstd`, and it is NOT one zstd
// stream — it is a CONCATENATION of independent frames (one per append). The
// streaming API therefore fails with "Unknown frame descriptor"; every frame has to
// be decompressed on its own and the results joined. This is the only way to read
// back what a session actually committed, which is how the composer's behaviour is
// verified from outside the app (there is no console and no CDP port here).
//
// Usage:
//   scripts/read-session.mjs <session-dir-or-.zstd-file> [--grep TEXT] [--users] [--json]
//
//   --grep TEXT  only print records whose serialized JSON contains TEXT
//   --users      only print user/assistant message text (role, index, size, head)
//   --json       print the raw JSONL records instead of a summary
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { join } from "node:path";

// zstd frame magic as a LITTLE-ENDIAN uint32 (the bytes are 28 b5 2f fd).
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Decode a concatenated-frame zstd file.
 *
 * The magic can also occur INSIDE a frame's compressed payload, so "split at every
 * magic" truncates real frames. Frames are found instead by trying each candidate
 * start against progressively later candidate ends and keeping the first slice that
 * actually decompresses — a false-positive magic then simply costs one retry.
 */
function decodeFrames(buf) {
  const magics = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf.readUInt32LE(i) === ZSTD_MAGIC) {
      magics.push(i);
      i += 3;
    }
  }
  const parts = [];
  for (let index = 0; index < magics.length; index += 1) {
    const start = magics[index];
    let decoded = null;
    for (let lookahead = 1; lookahead <= 6 && index + lookahead <= magics.length; lookahead += 1) {
      const end = index + lookahead < magics.length ? magics[index + lookahead] : buf.length;
      try {
        decoded = zstdDecompressSync(buf.subarray(start, end));
        index += lookahead - 1;
        break;
      } catch {
        /* a magic inside the payload: try the next candidate end */
      }
    }
    if (decoded !== null) parts.push(decoded);
  }
  return Buffer.concat(parts).toString("utf8");
}

function decode(path) {
  const raw = readFileSync(path);
  if (raw.length >= 4 && raw.readUInt32LE(0) === ZSTD_MAGIC) return decodeFrames(raw);
  return raw.toString("utf8");
}

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const grepAt = args.indexOf("--grep");
const needle = grepAt >= 0 ? args[grepAt + 1] : null;
const usersOnly = args.includes("--users");
const asJson = args.includes("--json");
if (target === undefined) {
  console.error("usage: read-session.mjs <session-dir|file> [--grep TEXT] [--users] [--json]");
  process.exit(2);
}
const file = target.endsWith(".zstd") || target.endsWith(".jsonl") ? target : join(target, "session.v4.jsonl.zstd");
const text = decode(file);

function summarize(record) {
  const message = record.message ?? record;
  const role = message?.role ?? record.type ?? "?";
  const content = message?.content;
  let body = "";
  if (typeof content === "string") body = content;
  else if (Array.isArray(content)) {
    body = content.map((part) => (typeof part === "string" ? part : (part?.text ?? part?.type ?? ""))).join(" ");
  } else if (record.text !== undefined) body = String(record.text);
  return { role, bytes: Buffer.byteLength(body), head: body.slice(0, 120).replace(/\n/g, "\\n") };
}

for (const line of text.split("\n")) {
  if (line.trim() === "") continue;
  if (needle !== null && !line.includes(needle)) continue;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    continue;
  }
  if (usersOnly) {
    const { role, bytes, head } = summarize(record);
    if (role !== "user" && role !== "assistant") continue;
    console.log(`${role}\t${bytes}B\t${head}`);
  } else if (asJson) {
    console.log(line);
  } else {
    console.log(line.slice(0, 400));
  }
}
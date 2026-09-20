#!/usr/bin/env python3
"""Read named keys out of a Chromium Local Storage leveldb directory.

Why this exists: the DSH renderer runs in its own partition, and this shell has
no console access to it (no CDP port, no screenshot, System Events denied). The
only in-app ground truth reachable from here is the renderer partition's Local
Storage, so the client half of the plugin writes diagnostics there and this
script reads them back.

Format, established empirically against a live renderer (this is NOT the classic
UTF-16 layout many write-ups describe):

    _http://127.0.0.1:43120 \\x00 \\x01 <key> \\x01 <utf8 json value> \\x01

Both the key and the value are plain UTF-8/ASCII, separated by 0x01, with the
value terminated by another 0x01. Records written by the live renderer sit in the
uncompacted .log file and are readable raw; .ldb blocks are snappy-compressed, so
those go through the decompressor below and are best-effort.

Usage:
  scripts/read-renderer-storage.py                          # every dsh.* key
  scripts/read-renderer-storage.py dsh.paste-spill.diag     # one key
  scripts/read-renderer-storage.py --json dsh.paste-spill.diag
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

DEFAULT_DIR = (
    Path.home()
    / "Library/Application Support/DSH Desktop/Partitions"
    / "dsh-desktop-renderer/Local Storage/leveldb"
)

# The storage origin Chromium prefixes every Local Storage key with, followed by
# its two-byte separator. Any origin is accepted so a different GUI port works.
KEY_PREFIX_RE = re.compile(rb"_https?://[^\x00]*\x00\x01")
# A record is `<origin>\x00\x01<key>\x01<value...>`; keys are dotted ASCII.
#
# The value cannot be delimited by `\x01`: in .ldb blocks a raw key/value pair
# carries a length/version preamble immediately before the payload, and that
# preamble itself contains 0x01 bytes. Even the block framing varies between
# compaction generations. So values are recovered structurally instead: find the
# key, then take the next balanced `{...}` object at depth 0, which is exactly
# the JSON the plugin wrote.
# NB: these are NOT raw literals — `\x00` must become an actual NUL byte. A
# raw bytes literal would leave it as the four characters `\x00` and never match.
RECORD_PREFIX = b"_https?://[^\x00]*\x00\x01"


def key_marker(key: str) -> bytes:
    """Regex matching the storage origin + separator + one exact key.

    The key is NOT followed by the value directly: both the .log and .ldb layouts
    interpose a small varint length preamble before the payload, and its bytes
    differ per record. So the marker asserts only that the key ENDS here (the
    lookahead rejects a longer key sharing this prefix) and the caller then locates
    the JSON object structurally.
    """
    return RECORD_PREFIX + re.escape(key.encode()) + b"(?![\\w.-])"


def json_objects_after(raw: bytes, key: str):
    """Yield every balanced JSON object that follows `key` in `raw`.

    Brace matching is quote- and escape-aware so a `}` inside a pasted string
    value cannot truncate the object.
    """
    marker = key_marker(key)
    for match in re.finditer(marker, raw):
        start = raw.find(b"{", match.end())
        if start < 0:
            continue
        depth = 0
        in_string = False
        escaped = False
        for pos in range(start, len(raw)):
            char = raw[pos]
            if in_string:
                if escaped:
                    escaped = False
                elif char == 0x5C:  # backslash
                    escaped = True
                elif char == 0x22:  # quote
                    in_string = False
                continue
            if char == 0x22:
                in_string = True
            elif char == 0x7B:
                depth += 1
            elif char == 0x7D:
                depth -= 1
                if depth == 0:
                    try:
                        yield json.loads(raw[start : pos + 1].decode("utf-8"))
                    except Exception:
                        pass
                    break


def snappy_decompress(data: bytes) -> bytes:
    """Decode a raw snappy block (the format leveldb blocks use)."""
    pos = 0
    length = 0
    shift = 0
    while True:
        if pos >= len(data):
            raise ValueError("truncated snappy preamble")
        byte = data[pos]
        pos += 1
        length |= (byte & 0x7F) << shift
        if not byte & 0x80:
            break
        shift += 7
    out = bytearray()
    while pos < len(data):
        tag = data[pos]
        pos += 1
        kind = tag & 0x03
        if kind == 0:  # literal
            size = tag >> 2
            if size < 60:
                count = size + 1
            else:
                extra = size - 59
                count = int.from_bytes(data[pos : pos + extra], "little") + 1
                pos += extra
            out += data[pos : pos + count]
            pos += count
            continue
        if kind == 1:
            size = ((tag >> 2) & 0x07) + 4
            offset = ((tag >> 5) << 8) | data[pos]
            pos += 1
        elif kind == 2:
            size = (tag >> 2) + 1
            offset = int.from_bytes(data[pos : pos + 2], "little")
            pos += 2
        else:
            size = (tag >> 2) + 1
            offset = int.from_bytes(data[pos : pos + 4], "little")
            pos += 4
        start = len(out) - offset
        if start < 0:
            raise ValueError("snappy copy before start of output")
        for i in range(size):
            out.append(out[start + i])
    if len(out) != length:
        raise ValueError(f"snappy length mismatch: {len(out)} != {length}")
    return bytes(out)


def read_varint(data: bytes, pos: int):
    """Read a leveldb varint. Returns (value, next_pos)."""
    result = 0
    shift = 0
    while True:
        if pos >= len(data):
            raise ValueError("truncated varint")
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7


# magic number that terminates a leveldb footer
TABLE_MAGIC = 0xDB4775248B80FB57


def block_payload(raw: bytes, offset: int, size: int) -> bytes:
    """Return one leveldb block's decompressed payload."""
    end = min(offset + size, len(raw))
    block = raw[offset:end]
    if len(block) < 5:
        return b""
    body, trailer = block[:-5], block[-5]
    if trailer == 1:  # snappy
        try:
            return snappy_decompress(body)
        except Exception:
            return b""
    return body


def ldb_payloads(raw: bytes):
    """Yield the decompressed payload of every data block in one .ldb file.

    Walking the footer -> index block -> data blocks is the only reliable way to
    locate records: the interesting bytes are inside snappy blocks, so a raw
    regex over the file matches the key but hands back compressed garbage as the
    value (which is exactly the bug this replaced).
    """
    if len(raw) < 48:
        return
    footer = raw[-48:]
    if int.from_bytes(footer[-8:], "little") != TABLE_MAGIC:
        return
    try:
        _, pos = read_varint(footer, 0)  # metaindex offset (unused)
        _, pos = read_varint(footer, pos)  # metaindex size (unused)
        index_offset, pos = read_varint(footer, pos)
        index_size, _ = read_varint(footer, pos)
    except Exception:
        return
    index = block_payload(raw, index_offset, index_size)
    # Index entries are (key, block-handle); walk them sequentially rather than
    # via the restart array, since we never need random access.
    pos = 0
    handles = []
    while pos < len(index):
        try:
            _, pos = read_varint(index, pos)  # shared
            non_shared, pos = read_varint(index, pos)
            value_len, pos = read_varint(index, pos)
        except Exception:
            break
        pos += non_shared
        value = index[pos : pos + value_len]
        pos += value_len
        try:
            data_offset, next_pos = read_varint(value, 0)
            data_size, _ = read_varint(value, next_pos)
            handles.append((data_offset, data_size))
        except Exception:
            continue
    for data_offset, data_size in handles:
        payload = block_payload(raw, data_offset, data_size)
        if payload:
            yield payload


def iter_records(directory: Path):
    """Yield (filename, key, raw buffer) for every file that mentions `key`.

    Every representation of a key is searched: the raw bytes plus each
    decompressed .ldb data block, so compaction generation does not matter.
    """
    for path in sorted(directory.iterdir()):
        if path.suffix not in {".ldb", ".log"}:
            continue
        raw = path.read_bytes()
        yield path.name, raw
        if path.suffix == ".ldb":
            for block in ldb_payloads(raw):
                yield f"{path.name}#block", block


def render(name: str, key: str, value, as_json: bool) -> None:
    if as_json:
        print(json.dumps({"file": name, "key": key, "value": value}, ensure_ascii=False))
        return
    print(f"[{name}] {key}")
    print(json.dumps(value, ensure_ascii=False, indent=2))
    print("-" * 60)


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--json"]
    as_json = "--json" in sys.argv
    directory = Path(os.environ.get("RENDERER_STORAGE_DIR", DEFAULT_DIR))
    if not directory.is_dir():
        print(f"not a directory: {directory}", file=sys.stderr)
        return 2
    wanted = args or ["dsh.paste-spill.diag"]

    found = False
    seen: set[str] = set()
    for name, raw in iter_records(directory):
        for key in wanted:
            for value in json_objects_after(raw, key):
                encoded = json.dumps(value, sort_keys=True, ensure_ascii=False)
                if encoded in seen:
                    continue
                seen.add(encoded)
                found = True
                render(name, key, value, as_json)

    if not found:
        print("no matching keys found", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
#!/usr/bin/env python3
"""Read keys out of a Chromium Local Storage leveldb without snappy bindings.

Why this exists: the renderer partition's Local Storage is the only in-app ground
truth this shell can reach (no CDP port, no console, OS scripting denied), and the
plugin writes its diagnostics there. Chromium compacts its log into `.ldb` SSTables
whose blocks are SNAPPY-compressed, and neither `python-snappy` nor `cramjam` is
available here -- hence the raw decompressor and a small SSTable reader below.

Two format details that a naive reader gets wrong (both fixed here -- see the
BUG HISTORY note at the bottom of this docstring):

  1. A BlockHandle's `size` is the length of the *block contents only*.  The
     5-byte block trailer (1 compression-type byte + 4-byte masked CRC32C) sits
     at `data[offset + size]`, i.e. the byte the handle points past.  Reading
     `data[offset:offset + size + 1]` and taking `[-1]` as the type byte both
     mislabels the block and truncates its content by one byte.
  2. A block's entry region ends where its restart array begins: the final 4
     bytes are the restart count, preceded by `count * 4` bytes of restart
     offsets.  Entries must not be parsed into that array.

Compression type values are the stock leveldb enum: 0 = none, 1 = snappy,
2 = zstd (not produced by this store).

Usage:
  scripts/read-leveldb.py [--all] [--key SUBSTRING] [--json OUT.json] <leveldb-dir>

Prints, per matching key: the newest value (highest sequence number), plus every
older value with --all.  The internal key carries an 8-byte (seq<<8|type) suffix
that the reader strips.  `--json` writes the flat, chronological record list.

BUG HISTORY: the previous revision sliced the trailer into the block body.  On the
index block of 000006.ldb that made the snappy stream one byte short of its own
preamble (declared 532, produced 531) and then starved the entry parser, which ran
into the restart array and raised IndexError.  Both symptoms had this one cause.
"""
import json
import os
import struct
import sys

FOOTER_MAGIC = 0xDB4775248B80FB57
BLOCK_TRAILER_SIZE = 5
FOOTER_SIZE = 48

# leveldb CompressionType
NO_COMPRESSION = 0
SNAPPY_COMPRESSION = 1
ZSTD_COMPRESSION = 2

# leveldb log record types
LOG_FULL, LOG_FIRST, LOG_MIDDLE, LOG_LAST = 1, 2, 3, 4

DIAG_KEY = "dsh.paste-spill.diag"
VALUE_TYPE_UTF16 = 0
VALUE_TYPE_LATIN1 = 1


def read_varint(buf, pos):
    result = 0
    shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if byte < 0x80:
            return result, pos
        shift += 7


def decode_varint(buf, pos):
    """(value, new_pos) or (None, pos) when the varint runs off the end."""
    result = 0
    shift = 0
    while pos < len(buf):
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if byte < 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            return None, pos
    return None, pos


def snappy_decompress(buf, trace=None):
    """Raw Snappy: preamble length varint, then literal/copy tags (2-bit).

    `trace`, when a list, collects one line per element -- the byte-level evidence
    needed to show exactly where a truncated stream falls short.
    """
    length, pos = read_varint(buf, 0)
    out = bytearray()
    index = 0
    while pos < len(buf):
        tag = buf[pos]
        pos += 1
        index += 1
        kind = tag & 3
        if kind == 0:  # literal
            size = tag >> 2
            if size >= 60:
                extra = size - 59
                size = int.from_bytes(buf[pos:pos + extra], "little")
                pos += extra
            size += 1
            chunk = buf[pos:pos + size]
            if len(chunk) != size:
                raise ValueError(
                    f"snappy: literal truncated (want {size}, have {len(chunk)}) "
                    f"at input {pos}, out={len(out)}/{length}")
            out += chunk
            pos += size
            if trace is not None:
                trace.append(f"#{index} literal len={size} in={pos} out={len(out)}")
            continue
        if kind == 1:  # copy with 1-byte offset
            size = ((tag >> 2) & 0x7) + 4
            offset = ((tag >> 5) << 8) | buf[pos]
            pos += 1
        elif kind == 2:  # copy with 2-byte offset
            size = (tag >> 2) + 1
            offset = int.from_bytes(buf[pos:pos + 2], "little")
            pos += 2
        else:  # copy with 4-byte offset
            size = (tag >> 2) + 1
            offset = int.from_bytes(buf[pos:pos + 4], "little")
            pos += 4
        start = len(out) - offset
        if start < 0:
            raise ValueError(f"snappy: offset {offset} before start of output "
                             f"(out={len(out)}) at element #{index}")
        for i in range(size):
            out.append(out[start + i])
        if trace is not None:
            trace.append(f"#{index} copy len={size} off={offset} in={pos} out={len(out)}")
    if len(out) != length:
        raise ValueError(
            f"snappy: length mismatch produced {len(out)} != declared {length} "
            f"(input {len(buf)} bytes, {index} elements; "
            f"{length - len(out)} byte(s) missing)")
    return bytes(out)


def read_block(data, offset, size):
    """BlockHandle (offset, size) -> uncompressed block bytes.

    BUG FIX 1: the compression type is the trailer byte at offset+size, not the
    last byte of the block's own content.
    """
    body = data[offset:offset + size]
    if len(body) != size:
        raise ValueError(f"block at {offset}+{size} runs past end of file")
    compression = data[offset + size]
    if compression == SNAPPY_COMPRESSION:
        return snappy_decompress(body)
    if compression == NO_COMPRESSION:
        return body
    raise ValueError(f"unsupported block compression {compression} at {offset}")


def parse_block(block):
    """LevelDB block -> [(internal_key, value)] ; internal_key has the seq suffix.

    BUG FIX 2: stop at the restart array instead of walking into it.
    """
    if len(block) < 4:
        return []
    restart_count = int.from_bytes(block[-4:], "little")
    restart_start = len(block) - 4 - restart_count * 4
    if restart_start < 0:
        raise ValueError(f"block too small for {restart_count} restarts "
                         f"({len(block)} bytes)")
    entries = []
    pos = 0
    key = b""
    while pos < restart_start:
        shared, pos = read_varint(block, pos)
        non_shared, pos = read_varint(block, pos)
        value_len, pos = read_varint(block, pos)
        if pos + non_shared + value_len > restart_start:
            raise ValueError("entry overruns restart array")
        key = key[:shared] + block[pos:pos + non_shared]
        pos += non_shared
        value = block[pos:pos + value_len]
        pos += value_len
        entries.append((key, value))
    return entries


def read_handle(buf, pos):
    offset, pos = read_varint(buf, pos)
    size, pos = read_varint(buf, pos)
    return (offset, size), pos


def read_sstable(path):
    """-> [(internal_key, value)] for every entry in the table."""
    data = open(path, "rb").read()
    if len(data) < FOOTER_SIZE:
        raise ValueError(f"{path}: too short to be an SSTable")
    magic = struct.unpack("<Q", data[-8:])[0]
    if magic != FOOTER_MAGIC:
        raise ValueError(f"{path}: bad footer magic {magic:#018x}")
    footer = data[-FOOTER_SIZE:-8]
    pos = 0
    _, pos = read_handle(footer, pos)              # metaindex
    (index_offset, index_size), pos = read_handle(footer, pos)
    index = parse_block(read_block(data, index_offset, index_size))
    out = []
    for _key, handle in index:
        (offset, size), _ = read_handle(handle, 0)
        out.extend(parse_block(read_block(data, offset, size)))
    return out


def read_log(path):
    """leveldb write-ahead log -> [(seq, internal_key, value)]."""
    data = open(path, "rb").read()
    records = []
    pos = 0
    pending = b""
    pending_seq = None
    while pos + 7 <= len(data):
        block_left = 32768 - (pos % 32768)
        if block_left < 7:                       # zero padding to block boundary
            pos += block_left
            continue
        _crc, length, rtype = struct.unpack("<IHB", data[pos:pos + 7])
        pos += 7
        if length > len(data) - pos:
            break
        chunk = data[pos:pos + length]
        pos += length
        if rtype == LOG_FULL:
            payload = chunk
        elif rtype == LOG_FIRST:
            pending, pending_seq = chunk, None
            continue
        elif rtype == LOG_MIDDLE:
            pending += chunk
            continue
        elif rtype == LOG_LAST:
            payload = pending + chunk
            pending = b""
        else:
            continue
        records.extend(parse_write_batch(payload))
    return records


def parse_write_batch(payload):
    """WriteBatch -> [(seq, user_key, value)]."""
    if len(payload) < 12:
        return []
    sequence = struct.unpack("<Q", payload[:8])[0]
    count = struct.unpack("<I", payload[8:12])[0]
    pos = 12
    out = []
    for i in range(count):
        if pos >= len(payload):
            break
        kind = payload[pos]
        pos += 1
        key_len, pos = decode_varint(payload, pos)
        if key_len is None or pos + key_len > len(payload):
            break
        key = payload[pos:pos + key_len]
        pos += key_len
        value = b""
        if kind == 1:                            # kTypeValue
            value_len, pos = decode_varint(payload, pos)
            if value_len is None or pos + value_len > len(payload):
                break
            value = payload[pos:pos + value_len]
            pos += value_len
        out.append((sequence + i, key, value))
    return out


def split_storage_key(user_key):
    """Chromium Local Storage key -> (origin, script_key).

    Layout: '_' + origin + 0x00 + 0x01 + script_key.
    """
    body = user_key[1:] if user_key[:1] == b"_" else user_key
    at = body.find(b"\x00\x01")
    if at < 0:
        return None, body.decode("utf-8", "replace")
    return (body[:at].decode("utf-8", "replace"),
            body[at + 2:].decode("utf-8", "replace"))


def decode_storage_value(raw):
    """Chromium Local Storage value -> str.

    The first byte is the encoding marker (0 = UTF-16LE, 1 = Latin-1).
    """
    if not raw:
        return ""
    marker, body = raw[0], raw[1:]
    if marker == VALUE_TYPE_UTF16 or (marker == 0 and len(body) % 2 == 0):
        try:
            return body.decode("utf-16-le")
        except UnicodeDecodeError:
            pass
    if marker == VALUE_TYPE_LATIN1:
        return body.decode("latin-1")
    return raw.decode("utf-8", "replace")


def collect(directory, want_origin=None):
    """-> [ {source, seq, origin, key, value_text, value} ] newest last."""
    records = []
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if name.endswith(".ldb"):
            try:
                for internal_key, value in read_sstable(path):
                    seq = struct.unpack("<Q", internal_key[-8:])[0] >> 8
                    origin, key = split_storage_key(internal_key[:-8])
                    records.append(dict(source=name, seq=seq, origin=origin,
                                        key=key, raw=value))
            except Exception as error:                # a torn table is not fatal
                print(f"# {name}: {type(error).__name__}: {error}", file=sys.stderr)
        elif name.endswith(".log"):
            try:
                for seq, user_key, value in read_log(path):
                    origin, key = split_storage_key(user_key)
                    records.append(dict(source=name, seq=seq, origin=origin,
                                        key=key, raw=value))
            except Exception as error:
                print(f"# {name}: {type(error).__name__}: {error}", file=sys.stderr)
    if want_origin:
        records = [r for r in records if r["origin"] == want_origin]
    records.sort(key=lambda r: (r["seq"], r["source"]))
    return records


def parse_value_json(text):
    try:
        parsed = json.loads(text)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


REPORT_FIELDS = """build applyRanAt watchAsk watchOk railSession foldDismissRef foldExpandRef
foldRefusePhase tick tickLen rtdVerdict rtdBytes rtdRecorded rtdRun rtdCurrent foldStoredBytes
foldChipInserted foldChipDeferred foldChipReason foldRolledBack foldChipHeldBytes foldChipFootprint
foldSkipped foldRefuseLiveRev foldRefuseSentRev foldSerializeBytes spilledTextRemoved uploadStartBytes
uploadFailed uploadFailureDetail pasteTargetRejected beforeInputPasteTargetRejected sendCommitted
lastDecision transitionCount""".split()


def local_clock(ms):
    import datetime
    return datetime.datetime.fromtimestamp(ms / 1000.0).strftime("%H:%M:%S")


def print_report(records):
    """Per-snapshot diagnostic report, applyRanAt rendered as local HH:MM:SS."""
    for index, record in enumerate(records, 1):
        value = record["value"]
        if not isinstance(value, dict):
            print(f"[{index:02d}] seq={record['seq']} {record['source']} "
                  f"<not a JSON object>")
            continue
        parts = []
        for field in REPORT_FIELDS:
            if field not in value:
                continue
            item = value[field]
            if field == "applyRanAt" and isinstance(item, (int, float)):
                item = f"{int(item)} ({local_clock(item)})"
            parts.append(f"{field}={item}")
        print(f"[{index:02d}] seq={record['seq']} {record['source']} "
              f"{' '.join(parts)}")


def main(argv):
    show_all = "--all" in argv
    argv = [a for a in argv if a != "--all"]
    report = "--report" in argv
    argv = [a for a in argv if a != "--report"]
    stdout_json = "--stdout-json" in argv
    argv = [a for a in argv if a != "--stdout-json"]
    wanted = None
    if "--key" in argv:
        at = argv.index("--key")
        wanted = argv[at + 1]
        argv = argv[:at] + argv[at + 2:]
    json_out = None
    if "--json" in argv:
        at = argv.index("--json")
        json_out = argv[at + 1]
        argv = argv[:at] + argv[at + 2:]
    directory = argv[0]

    records = collect(directory)
    for record in records:
        record["value_text"] = decode_storage_value(record["raw"])
        record["value"] = parse_value_json(record["value_text"])
    selected = [r for r in records if wanted is None or wanted in r["key"]]

    if json_out or stdout_json:
        payload = [
            {
                "source": r["source"],
                "key": r["key"],
                "seq": r["seq"],
                "value": r["value"] if r["value"] is not None else r["value_text"],
            }
            for r in selected
        ]
        text = json.dumps(payload, ensure_ascii=False, indent=2)
        if json_out:
            with open(json_out, "w", encoding="utf-8") as handle:
                handle.write(text + "\n")
            print(f"# wrote {len(payload)} records to {json_out}", file=sys.stderr)
        if stdout_json:
            print(text)

    if report:
        print_report(selected)

    if json_out or report or stdout_json:
        return

    by_key = {}
    for record in records:
        if wanted is not None and wanted not in record["key"]:
            continue
        by_key.setdefault(record["key"], []).append(record)
    if not by_key:
        print("no matching records", file=sys.stderr)
        return
    for key, items in sorted(by_key.items()):
        items.sort(key=lambda r: r["seq"], reverse=True)
        shown = items if show_all else items[:1]
        for record in shown:
            print(f"--- {key} seq={record['seq']} ({record['source']}) "
                  f"origin={record['origin']}")
            text = record["value_text"]
            if record["value"] is not None:
                print(json.dumps(record["value"], indent=2)[:4000])
            else:
                print(text.strip()[:4000])


if __name__ == "__main__":
    main(sys.argv[1:])
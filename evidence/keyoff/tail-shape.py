"""Trailing-NUL run and last-line completeness for each candump log.

A power cut leaves the delalloc signature described in docs/power-cuts.md: i_size
published, blocks never written back, so the file ends in NULs. A file whose last
line is cut mid-way is the same event caught without a NUL run.

⚠️ Those two measurements are about RAW bytes and say nothing about a `.log.gz`, where
the trailing NULs are compressed-stream bytes and a 4096-byte boundary means nothing.
Compressed captures take the second branch below, which measures the same event in the
only terms that survive compression: how many 64 kB members completed, how much decodes,
and whether the last decodable line is whole. That is the instrument docs/can-capture.md
§"⚠️ Still open: the loss figures are arithmetic plus one evening" is waiting on — it
needs a week of real .log.gz captures before the 0.57 s / 0.97 s figures there can be
quoted as measured rather than derived.
"""
import json
import os
import sys
import zlib

CHUNK = 1 << 20

def trailing_nulls(handle, size):
    run = 0
    position = size
    while position > 0:
        step = min(CHUNK, position)
        position -= step
        handle.seek(position)
        block = handle.read(step)
        index = len(block) - 1
        while index >= 0 and block[index] == 0:
            run += 1
            index -= 1
        if index >= 0:
            return run
    return run

def gzip_tail(path, size):
    """Members completed, bytes recovered, and whether the last line is whole."""
    with open(path, "rb") as handle:
        body = handle.read()
    decoded, members, position, cut = bytearray(), 0, 0, False
    while position < len(body):
        machine = zlib.decompressobj(31)
        try:
            decoded += machine.decompress(body[position:])
            decoded += machine.flush()
        except zlib.error:
            # Not the ordinary cut — that is `eof` below. This is a member whose bytes are
            # corrupt rather than merely absent, which is what a NUL run decodes as.
            cut = True
            break
        # ⚠️ `decompress()` does NOT raise on a member that simply stops early: it returns
        # what it has and waits for bytes that never come, and `flush()` does not raise
        # either. `eof` is the only thing that distinguishes a complete member from a cut
        # one. An earlier draft tested for an exception and reported every truncated
        # capture as clean.
        if not machine.eof:
            cut = True
            break
        members += 1
        if not machine.unused_data:
            break
        position = len(body) - len(machine.unused_data)
    return {"path": os.path.basename(path), "size": size, "members": members,
            "cutMember": cut, "decoded": len(decoded),
            "endsWithNewline": decoded.endswith(b"\n") if decoded else None}


for path in sys.argv[1:]:
    size = os.path.getsize(path)
    if path.endswith(".gz"):
        print(json.dumps(gzip_tail(path, size)))
        continue
    with open(path, "rb") as handle:
        nulls = trailing_nulls(handle, size)
        end = size - nulls
        tail_start = max(0, end - 4096)
        handle.seek(tail_start)
        tail = handle.read(end - tail_start)
    complete = tail.endswith(b"\n") if tail else None
    print(json.dumps({"path": os.path.basename(path), "size": size, "nulls": nulls, "endsWithNewline": complete}))

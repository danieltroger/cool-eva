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
#: Smaller than CHUNK on purpose. `decompressobj.unused_data` is a fresh copy of everything
#: after the member just finished, so a window spanning N members copies it ~N/2 times over.
#: A real capture is ~8 kB compressed per 64 kB member, so a 1 MiB window spans ~130 of them
#: and costs ~65 MiB of memcpy per MiB read; 64 KiB spans ~8 and costs ~16x less.
GZIP_WINDOW = 1 << 16

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
    """Members completed, bytes recovered, and whether the last line is whole.

    Streams: one pass, a 1 MiB window, counters rather than a buffer. The obvious version
    — slice the file from the current member and decompress the rest — is O(members^2) in
    copying and holds the whole decompressed capture in memory. A real 8 h capture is
    ~50 000 members and ~3 GB decompressed, so that version could not do this job at all.
    """
    members, decoded, cut, last_byte, fed = 0, 0, False, None, False
    machine = zlib.decompressobj(31)
    with open(path, "rb") as handle:
        while not cut:
            chunk = handle.read(GZIP_WINDOW)
            if not chunk:
                break
            while chunk:
                fed = True
                try:
                    out = machine.decompress(chunk)
                except zlib.error:
                    # Corrupt rather than merely absent — what a NUL run decodes as once it
                    # lands past a member boundary. Everything before it is still intact.
                    cut = True
                    break
                decoded += len(out)
                if out:
                    last_byte = out[-1]
                if not machine.eof:
                    break
                members += 1
                chunk = machine.unused_data
                machine = zlib.decompressobj(31)
                fed = False
    # A member that was fed and never reached its end marker is the ordinary power cut.
    if fed and not machine.eof:
        cut = True
    return {"path": os.path.basename(path), "size": size, "members": members,
            "cutMember": cut, "decoded": decoded,
            "endsWithNewline": (last_byte == 0x0A) if last_byte is not None else None}


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

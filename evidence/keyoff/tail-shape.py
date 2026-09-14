"""Trailing-NUL run and last-line completeness for each candump log.

A power cut leaves the delalloc signature described in docs/power-cuts.md: i_size
published, blocks never written back, so the file ends in NULs. A file whose last
line is cut mid-way is the same event caught without a NUL run.
"""
import json
import os
import sys

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

for path in sys.argv[1:]:
    size = os.path.getsize(path)
    with open(path, "rb") as handle:
        nulls = trailing_nulls(handle, size)
        end = size - nulls
        tail_start = max(0, end - 4096)
        handle.seek(tail_start)
        tail = handle.read(end - tail_start)
    complete = tail.endswith(b"\n") if tail else None
    print(json.dumps({"path": os.path.basename(path), "size": size, "nulls": nulls, "endsWithNewline": complete}))

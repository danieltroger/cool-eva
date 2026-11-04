"""Test host only: give the Node input fixture a real controlling terminal."""
import errno
import os
import selectors
import signal
import sys


def stop_child(_signal, _frame):
    os.killpg(child_pid, signal.SIGKILL)


child_pid, terminal = os.forkpty()
if child_pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])

signal.signal(signal.SIGTERM, stop_child)
selector = selectors.DefaultSelector()
selector.register(terminal, selectors.EVENT_READ)
selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
while True:
    ended = False
    for event, _mask in selector.select():
        try:
            data = os.read(event.fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            data = b""
        if not data:
            if event.fd == terminal:
                ended = True
                break
            selector.unregister(event.fd)
        elif event.fd == terminal:
            os.write(sys.stdout.fileno(), data)
        else:
            written = 0
            while written < len(data):
                written += os.write(terminal, data[written:])
    if ended:
        break
os.close(terminal)
_pid, status = os.waitpid(child_pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))

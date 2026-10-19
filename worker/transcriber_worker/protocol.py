"""JSON-lines protocol between the Node scheduler and a worker process.

stdin  : {"type":"call","id":..,"op":..,"params":{..}}
         {"type":"control","id":..,"action":"cancel"|"pause"}
         {"type":"shutdown"}
stdout : {"type":"ready"|"progress"|"log"|"result"|"error", ...}

Library code (NeMo, transformers, tqdm) loves printing to stdout, which would corrupt
the protocol, so `install_stdout_guard()` moves the real stdout to a private fd and
points fd 1 at stderr.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from typing import Any


class _Channel:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._out = None

    def install(self) -> None:
        sys.stdout.flush()
        proto_fd = os.dup(1)
        os.dup2(2, 1)  # anything printed to fd 1 now lands on stderr
        self._out = os.fdopen(proto_fd, "w", buffering=1, encoding="utf-8")
        sys.stdout = sys.stderr

    def send(self, msg: dict[str, Any]) -> None:
        line = json.dumps(msg, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            out = self._out or sys.__stdout__
            out.write(line + "\n")
            out.flush()


channel = _Channel()


def install_stdout_guard() -> None:
    channel.install()


class Cancelled(Exception):
    """Raised inside a task when the scheduler asked to cancel."""


class Paused(Exception):
    """Raised at a safe boundary when the scheduler asked to pause."""


class WorkerError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class TaskContext:
    def __init__(self, call_id: str, op: str) -> None:
        self.id = call_id
        self.op = op
        self.cancel_requested = threading.Event()
        self.pause_requested = threading.Event()
        self._last_progress = 0.0

    def progress(self, done: float, total: float | None, unit: str, force: bool = False, **detail: Any) -> None:
        now = time.monotonic()
        if not force and now - self._last_progress < 0.5:
            return
        self._last_progress = now
        channel.send({"type": "progress", "id": self.id, "done": done, "total": total, "unit": unit, "detail": detail})

    def log(self, message: str, level: str = "info", **data: Any) -> None:
        channel.send({"type": "log", "id": self.id, "level": level, "message": message, "data": data})

    def check(self, allow_pause: bool = True) -> None:
        """Call at safe boundaries."""
        if self.cancel_requested.is_set():
            raise Cancelled()
        if allow_pause and self.pause_requested.is_set():
            raise Paused()

    def check_cancel(self) -> None:
        if self.cancel_requested.is_set():
            raise Cancelled()

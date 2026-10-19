"""Atomic, versioned JSON checkpoints. A checkpoint is only reused when its version
and parameter fingerprint match the current call, so a half-written or stale file
can never be resumed from."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from typing import Any

CHECKPOINT_VERSION = 1


def fingerprint(params: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(params, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:32]


def write_json_atomic(path: str, data: Any) -> None:
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        try:
            dfd = os.open(d, os.O_RDONLY)
            os.fsync(dfd)
            os.close(dfd)
        except OSError:
            pass
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class Checkpoint:
    def __init__(self, path: str | None, op: str, fp: str) -> None:
        self.path = path
        self.op = op
        self.fp = fp
        self.items: dict[str, Any] = {}
        self.meta: dict[str, Any] = {}
        self._dirty = 0
        self._last_write = time.monotonic()
        self.resumed = 0
        if path and os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("version") == CHECKPOINT_VERSION and data.get("op") == op and data.get("fingerprint") == fp:
                    self.items = data.get("items", {})
                    self.meta = data.get("meta", {})
                    self.resumed = len(self.items)
            except (OSError, ValueError):
                self.items = {}

    def has(self, key: Any) -> bool:
        return str(key) in self.items

    def get(self, key: Any) -> Any:
        return self.items.get(str(key))

    def put(self, key: Any, value: Any) -> None:
        self.items[str(key)] = value
        self._dirty += 1
        if self._dirty >= 10 or time.monotonic() - self._last_write > 10:
            self.flush()

    def flush(self) -> None:
        if not self.path or self._dirty == 0:
            return
        write_json_atomic(
            self.path,
            {"version": CHECKPOINT_VERSION, "op": self.op, "fingerprint": self.fp, "items": self.items, "meta": self.meta, "saved_at": time.time()},
        )
        self._dirty = 0
        self._last_write = time.monotonic()

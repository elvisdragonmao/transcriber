"""Lazy model registry with idle unloading and OOM-aware loading.

One worker process serves one lane (one physical device), so this registry is the
only place that decides what occupies that device's memory.
"""

from __future__ import annotations

import gc
import threading
import time
from typing import Any, Callable


def is_oom(e: BaseException) -> bool:
    try:
        import torch

        if isinstance(e, torch.cuda.OutOfMemoryError):
            return True
    except Exception:
        pass
    return "out of memory" in str(e).lower()


def free_cuda() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


class ModelRegistry:
    def __init__(self, idle_unload_s: float = 900, co_resident: str = "auto") -> None:
        self._models: dict[str, Any] = {}
        self._last_used: dict[str, float] = {}
        self._lock = threading.RLock()
        self.idle_unload_s = idle_unload_s
        self.co_resident = co_resident
        self.busy = False
        threading.Thread(target=self._reaper, daemon=True).start()

    def get(self, name: str, loader: Callable[[], Any]) -> Any:
        with self._lock:
            if name in self._models:
                self._last_used[name] = time.monotonic()
                return self._models[name]
            if self.co_resident == "never":
                self.unload_all(except_=name)
            try:
                model = loader()
            except BaseException as e:
                if not is_oom(e) or not self._models:
                    raise
                # Not enough room next to the other resident model: evict and retry once.
                self.unload_all(except_=name)
                model = loader()
            self._models[name] = model
            self._last_used[name] = time.monotonic()
            return model

    def unload(self, name: str) -> None:
        with self._lock:
            if self._models.pop(name, None) is not None:
                self._last_used.pop(name, None)
                free_cuda()

    def unload_all(self, except_: str | None = None) -> None:
        with self._lock:
            for n in list(self._models):
                if n != except_:
                    self._models.pop(n, None)
                    self._last_used.pop(n, None)
            free_cuda()

    def loaded(self) -> list[str]:
        with self._lock:
            return list(self._models)

    def _reaper(self) -> None:
        while True:
            time.sleep(15)
            if self.busy:
                continue
            now = time.monotonic()
            with self._lock:
                for n, t in list(self._last_used.items()):
                    if now - t > self.idle_unload_s:
                        self.unload(n)


def device_report() -> dict[str, Any]:
    out: dict[str, Any] = {}
    try:
        import torch

        out["torch"] = torch.__version__
        out["cuda_runtime"] = torch.version.cuda
        out["cuda_available"] = torch.cuda.is_available()
        if torch.cuda.is_available():
            p = torch.cuda.get_device_properties(0)
            out["device"] = {
                "name": p.name,
                "uuid": "GPU-" + str(getattr(p, "uuid", "")),
                "total_mib": p.total_memory // 2**20,
                "capability": f"{p.major}.{p.minor}",
                "allocated_mib": torch.cuda.memory_allocated() // 2**20,
                "reserved_mib": torch.cuda.memory_reserved() // 2**20,
            }
            out["arch_list"] = torch.cuda.get_arch_list()
    except Exception as e:  # pragma: no cover - diagnostics only
        out["error"] = str(e)
    return out

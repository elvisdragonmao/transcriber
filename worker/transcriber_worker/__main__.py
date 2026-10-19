"""Worker process entry point: `python -m transcriber_worker --lane gpu-asr`.

The scheduler starts one process per lane and pins it to a device with
CUDA_VISIBLE_DEVICES=<GPU UUID>, so inside the process the device is always cuda:0.
Exactly one task runs at a time; control messages (cancel / pause) arrive on stdin
while it runs.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import traceback

from .protocol import Cancelled, Paused, TaskContext, WorkerError, channel, install_stdout_guard

LANE_OPS = {
    "gpu-asr": {"asr", "align", "health", "unload"},
    "gpu-diar": {"diarize", "health", "unload"},
    "cpu": {"vad", "embed", "diarize", "health", "unload"},
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lane", required=True, choices=sorted(LANE_OPS))
    ap.add_argument("--idle-unload", type=float, default=float(os.environ.get("IDLE_UNLOAD_S", "900")))
    ap.add_argument("--co-resident", default=os.environ.get("CO_RESIDENT", "auto"))
    args = ap.parse_args()

    install_stdout_guard()
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    from .models import ModelRegistry, device_report, free_cuda, is_oom

    models = ModelRegistry(idle_unload_s=args.idle_unload, co_resident=args.co_resident)
    tasks: "queue.Queue[dict]" = queue.Queue()
    current: dict[str, TaskContext] = {}

    def execute(msg: dict) -> None:
        call_id, op, params = msg["id"], msg["op"], msg.get("params", {})
        ctx = TaskContext(call_id, op)
        current["ctx"] = ctx
        models.busy = True
        try:
            if op not in LANE_OPS[args.lane]:
                raise WorkerError("BAD_OP", f"op {op!r} is not served by lane {args.lane}")
            if op == "health":
                result = {"lane": args.lane, "loaded": models.loaded(), **device_report()}
            elif op == "unload":
                models.unload_all()
                result = {"loaded": models.loaded()}
            elif op == "vad":
                from .vad import run_vad

                result = run_vad(ctx, params)
            elif op == "asr":
                from .asr import run_asr

                result = run_asr(ctx, params, models)
            elif op == "align":
                from .align import run_align

                result = run_align(ctx, params, models)
            elif op == "diarize":
                from .diarize import run_diarize

                result = run_diarize(ctx, params, models)
            elif op == "embed":
                from .speaker import run_embed

                result = run_embed(ctx, params, models)
            else:  # pragma: no cover
                raise WorkerError("BAD_OP", op)
            channel.send({"type": "result", "id": call_id, "result": result})
        except Paused:
            channel.send({"type": "result", "id": call_id, "result": {"status": "paused"}})
        except Cancelled:
            free_cuda()
            channel.send({"type": "error", "id": call_id, "code": "CANCELLED", "message": "cancelled", "retryable": False})
        except WorkerError as e:
            free_cuda()
            channel.send({"type": "error", "id": call_id, "code": e.code, "message": str(e), "retryable": e.retryable})
        except BaseException as e:  # noqa: BLE001 - everything must be reported, never crash silently
            oom = is_oom(e)
            if oom:
                models.unload_all()
            free_cuda()
            traceback.print_exc(file=sys.stderr)
            channel.send(
                {
                    "type": "error",
                    "id": call_id,
                    "code": "OOM" if oom else ("NO_SPACE" if "No space left" in str(e) else "EXCEPTION"),
                    "message": f"{type(e).__name__}: {e}"[:2000],
                    "retryable": oom,
                }
            )
        finally:
            models.busy = False
            current.pop("ctx", None)

    def runner() -> None:
        while True:
            msg = tasks.get()
            if msg is None:
                return
            execute(msg)

    t = threading.Thread(target=runner, daemon=True)
    t.start()
    channel.send({"type": "ready", "lane": args.lane, "pid": os.getpid(), "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES")})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        kind = msg.get("type")
        if kind == "call":
            tasks.put(msg)
        elif kind == "control":
            ctx = current.get("ctx")
            if ctx and ctx.id == msg.get("id"):
                if msg.get("action") == "cancel":
                    ctx.cancel_requested.set()
                elif msg.get("action") == "pause":
                    ctx.pause_requested.set()
        elif kind == "shutdown":
            break
    tasks.put(None)
    ctx = current.get("ctx")
    if ctx:
        ctx.cancel_requested.set()
    t.join(timeout=10)
    os._exit(0)


if __name__ == "__main__":
    main()

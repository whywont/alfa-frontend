"""
The worker loop. Runs anywhere with outbound HTTPS: a Colab or molab
notebook, a lab workstation, a SLURM job.

    python -m alfa_worker --server https://alfa.example --backend colab --runner esmfold

It pulls a job, holds its lease with heartbeats while a child process folds,
uploads the outputs, and reports back. If this process dies, the lease runs
out and the server hands the job to the next worker; nothing here has to
clean up after itself.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from pathlib import Path

from . import __version__
from .client import ApiError, Client, LeaseLost, Lease
from .runners import load


def log(msg: str) -> None:
    print(f"[alfa-worker {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def gpu_name() -> str | None:
    if not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10,
        )
        return out.stdout.strip().splitlines()[0] if out.returncode == 0 and out.stdout.strip() else None
    except (OSError, subprocess.TimeoutExpired):
        return None


class HeartbeatThread(threading.Thread):
    """Renews the lease and ships log lines until stopped. Flags cancel or lease loss for the main thread."""

    def __init__(self, client: Client, lease: Lease, interval: float):
        super().__init__(daemon=True)
        self.client, self.lease, self.interval = client, lease, interval
        self.lines: deque[str] = deque()
        self.stop_event = threading.Event()
        self.cancelled = threading.Event()
        self.lease_lost = threading.Event()

    def add_line(self, line: str) -> None:
        self.lines.append(line)

    def flush(self) -> None:
        batch = []
        while self.lines and len(batch) < 500:
            batch.append(self.lines.popleft())
        try:
            result = self.client.heartbeat(self.lease, batch)
            if result.get("cancel"):
                self.cancelled.set()
        except LeaseLost:
            self.lease_lost.set()
        except ApiError as err:
            # Keep going: the lease is 8 heartbeats long, so a blip isn't fatal.
            log(f"heartbeat failed: {err}")
            self.lines.extendleft(reversed(batch))

    def run(self) -> None:
        while not self.stop_event.wait(self.interval):
            self.flush()
            if self.lease_lost.is_set():
                return

    def stop(self) -> None:
        self.stop_event.set()
        self.join(timeout=5)


def terminate(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def run_one(client: Client, claimed: dict, runner: str, workdir: Path) -> None:
    lease = Lease(claimed["jobId"], claimed["attemptId"], claimed["leaseToken"])
    job = claimed["job"]
    log(f"claimed {lease.job_id} ({job['name']}, attempt {claimed['attemptNo']})")

    outdir = workdir / lease.job_id / f"attempt-{claimed['attemptNo']}"
    outdir.mkdir(parents=True, exist_ok=True)
    job_path = outdir / "job.json"
    job_path.write_text(json.dumps(job))

    hb = HeartbeatThread(client, lease, float(claimed.get("heartbeatSeconds", 15)))
    hb.add_line(f"Worker {socket.gethostname()} picked up attempt {claimed['attemptNo']}")
    hb.start()

    proc = subprocess.Popen(
        [sys.executable, "-u", "-m", "alfa_worker.run_job", runner, str(job_path), str(outdir)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    reader = threading.Thread(target=lambda: [hb.add_line(l.rstrip()) for l in proc.stdout], daemon=True)
    reader.start()

    try:
        while proc.poll() is None:
            if hb.cancelled.is_set() or hb.lease_lost.is_set():
                terminate(proc)
                break
            time.sleep(0.5)
        reader.join(timeout=5)

        if hb.lease_lost.is_set():
            log("lost the lease; dropping this job")
            return
        if hb.cancelled.is_set():
            hb.flush()
            client.fail(lease, "cancelled", "Stopped at the user's request.", retryable=False)
            log("cancelled")
            return

        hb.flush()  # send the tail of the log before reporting
        result_file, error_file = outdir / "result.json", outdir / "error.json"
        if proc.returncode == 0 and result_file.exists():
            result = json.loads(result_file.read_text())
            for out in result["outputs"]:
                client.upload(lease, outdir / out["file"], out["kind"], out["content_type"], out.get("rank"))
            provenance = {"model_version": result["model_version"], **result.get("notes", {})}
            state = client.complete(lease, result["metrics"], provenance)
            log(f"done: {state}")
        elif error_file.exists():
            err = json.loads(error_file.read_text())
            state = client.fail(lease, err["code"], err["message"], err["retryable"])
            log(f"failed ({err['code']}): {state}")
        else:
            tail = [l for l in list(hb.lines)[-5:]]
            state = client.fail(
                lease, "runner_crashed",
                f"The folding process exited unexpectedly (code {proc.returncode}).", retryable=True,
            )
            log(f"runner crashed ({proc.returncode}): {state} {tail}")
    except LeaseLost:
        log("lost the lease while reporting; the server has moved on")
    finally:
        terminate(proc)
        hb.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server", default=os.environ.get("ALFA_SERVER"), help="Alfa base URL (or ALFA_SERVER)")
    parser.add_argument("--token", default=os.environ.get("ALFA_WORKER_TOKEN"), help="worker token (or ALFA_WORKER_TOKEN)")
    parser.add_argument("--backend", default=os.environ.get("ALFA_BACKEND", "local"), help="colab, molab, local, slurm, ...")
    parser.add_argument("--runner", default="esmfold", help="esmfold (local GPU) or esmatlas (remote API)")
    parser.add_argument("--max-residues", type=int, help="override the runner's limit for this GPU")
    parser.add_argument("--once", action="store_true", help="run at most one job, then exit")
    parser.add_argument("--idle-exit", type=float, help="exit after this many seconds with no work")
    parser.add_argument("--workdir", type=Path, default=Path(tempfile.gettempdir()) / "alfa-worker")
    args = parser.parse_args()
    if not args.server or not args.token:
        parser.error("--server and --token (or ALFA_SERVER and ALFA_WORKER_TOKEN) are required")

    _, caps = load(args.runner)
    max_residues = args.max_residues or caps["max_residues"]
    client = Client(args.server, args.token)
    info = {
        "worker_version": __version__,
        "runner": args.runner,
        "host": socket.gethostname(),
        "gpu": gpu_name(),
        "python": platform.python_version(),
        "git_sha": os.environ.get("ALFA_WORKER_GIT_SHA"),
    }
    log(f"polling {args.server} as {args.backend}/{args.runner} (models={caps['models']}, max {max_residues} residues, gpu={info['gpu']})")

    stopping = False

    def on_signal(signum, _frame):
        nonlocal stopping
        stopping = True
        log("stopping after the current job")

    signal.signal(signal.SIGTERM, on_signal)

    idle, idle_since = 2.0, time.monotonic()
    while not stopping:
        try:
            claimed = client.claim(args.backend, caps["models"], max_residues, info)
        except ApiError as err:
            log(f"claim failed: {err}")
            claimed = None
        if claimed:
            run_one(client, claimed, args.runner, args.workdir)
            idle, idle_since = 2.0, time.monotonic()
            if args.once:
                return
            continue
        if args.idle_exit and time.monotonic() - idle_since > args.idle_exit:
            log("no work; exiting")
            return
        time.sleep(idle)
        idle = min(idle * 1.5, 30.0)


if __name__ == "__main__":
    main()

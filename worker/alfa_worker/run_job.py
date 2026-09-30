"""
Child process that runs one job: `python -m alfa_worker.run_job RUNNER JOB_JSON OUTDIR`.

Running the model in a child means cancellation is a kill, not a polite
request the model might ignore mid-forward-pass. Writes result.json on
success or error.json on a known failure; stdout is the job log.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path

from .runners import RunnerError, load


def main() -> int:
    runner_name, job_path, outdir = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    job = json.loads(job_path.read_text())
    run, _ = load(runner_name)

    def log(line: str) -> None:
        print(line, flush=True)

    try:
        result = run(job, outdir, log)
    except RunnerError as err:
        (outdir / "error.json").write_text(
            json.dumps({"code": err.code, "message": err.message, "retryable": err.retryable})
        )
        log(f"Failed: {err.message}")
        return 2
    (outdir / "result.json").write_text(json.dumps(asdict(result)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

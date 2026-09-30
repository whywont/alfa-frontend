"""
Runners turn a job into files. Each one is called in a child process:

    run(job: dict, outdir: Path, log: Callable[[str], None]) -> Result

and must write its outputs into `outdir`. A runner signals a known failure by
raising RunnerError with a code the server understands; anything else is
treated as a crash and retried.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


class RunnerError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


@dataclass
class Output:
    file: str
    kind: str  # structure | scores | pae | msa | log | other
    content_type: str
    rank: int | None = None


@dataclass
class Result:
    outputs: list[Output]
    metrics: dict[str, float]
    model_version: str
    notes: dict[str, str] = field(default_factory=dict)


def load(name: str) -> tuple[Callable, dict]:
    """Import a runner lazily, so the parent never loads torch."""
    if name == "esmfold":
        from . import esmfold as mod
    elif name == "esmatlas":
        from . import esmatlas as mod
    else:
        raise ValueError(f"unknown runner {name!r}")
    return mod.run, mod.CAPABILITIES

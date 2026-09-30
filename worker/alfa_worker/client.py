"""HTTP client for the Alfa worker API. Standard library only."""

from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class LeaseLost(Exception):
    """The server gave this job to someone else (our lease expired or it was cancelled away)."""


class ApiError(Exception):
    pass


@dataclass
class Lease:
    job_id: str
    attempt_id: str
    lease_token: str

    def as_body(self) -> dict[str, str]:
        return {"jobId": self.job_id, "attemptId": self.attempt_id, "leaseToken": self.lease_token}


class Client:
    def __init__(self, base_url: str, token: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _post(self, path: str, body: dict[str, Any], retries: int = 4) -> tuple[int, Any]:
        """POST JSON, retrying network errors and 5xx with backoff. 409 raises LeaseLost."""
        data = json.dumps(body).encode()
        delay = 2.0
        for attempt in range(retries + 1):
            req = urllib.request.Request(
                self.base_url + path,
                data=data,
                method="POST",
                headers={"authorization": f"Bearer {self.token}", "content-type": "application/json"},
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as res:
                    raw = res.read()
                    return res.status, json.loads(raw) if raw else None
            except urllib.error.HTTPError as err:
                if err.code == 409:
                    raise LeaseLost(err.read().decode(errors="replace")) from None
                if err.code < 500 or attempt == retries:
                    raise ApiError(f"{path}: HTTP {err.code} {err.read().decode(errors='replace')}") from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
                if attempt == retries:
                    raise ApiError(f"{path}: {err}") from None
            time.sleep(delay)
            delay *= 2
        raise AssertionError("unreachable")

    def claim(self, backend: str, models: list[str], max_residues: int, worker_info: dict[str, Any]) -> dict | None:
        status, body = self._post(
            "/api/worker/claim",
            {"backend": backend, "models": models, "maxResidues": max_residues, "workerInfo": worker_info},
        )
        return None if status == 204 else body

    def heartbeat(self, lease: Lease, logs: list[str], progress: dict | None = None) -> dict:
        _, body = self._post("/api/worker/heartbeat", {**lease.as_body(), "logs": logs, "progress": progress})
        return body

    def upload(self, lease: Lease, path: Path, kind: str, content_type: str, rank: int | None = None) -> None:
        """Get a signed URL, PUT the file there, then commit it. Safe to repeat."""
        data = path.read_bytes()
        _, target = self._post("/api/worker/upload-url", {**lease.as_body(), "name": path.name})
        req = urllib.request.Request(target["url"], data=data, method="PUT", headers={"content-type": content_type})
        with urllib.request.urlopen(req, timeout=300) as res:
            if res.status >= 300:
                raise ApiError(f"upload {path.name}: HTTP {res.status}")
        self._post(
            "/api/worker/artifacts",
            {
                **lease.as_body(),
                "name": path.name,
                "kind": kind,
                "rank": rank,
                "contentType": content_type,
                "sha256": hashlib.sha256(data).hexdigest(),
            },
        )

    def complete(self, lease: Lease, metrics: dict[str, float], provenance: dict | None = None) -> str:
        _, body = self._post(
            "/api/worker/complete", {**lease.as_body(), "metrics": metrics, "provenance": provenance or {}}
        )
        return body["state"]

    def fail(self, lease: Lease, code: str, message: str, retryable: bool) -> str:
        _, body = self._post(
            "/api/worker/fail", {**lease.as_body(), "code": code, "message": message, "retryable": retryable}
        )
        return body["state"]

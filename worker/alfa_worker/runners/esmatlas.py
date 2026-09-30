"""
ESMFold via Meta's public ESM Atlas API. A real fold, but on someone else's
GPU: good for testing the whole pipeline from a laptop. It returns no PAE, and
it sends the sequence to a third party, so the server should only route
non-sensitive sequences here.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

from . import Output, Result, RunnerError
from .pdb import ca_bfactors, scale_bfactors

CAPABILITIES = {"models": ["esmfold"], "max_residues": 400}
API = "https://api.esmatlas.com/foldSequence/v1/pdb/"


def run(job: dict, outdir: Path, log) -> Result:
    chains = job["chains"]
    if len(chains) != 1:
        raise RunnerError("unsupported_mode", "ESMFold here folds single chains only.")
    sequence = chains[0]["sequence"]
    log(f"Sending {len(sequence)} residues to the ESM Atlas API")
    req = urllib.request.Request(API, data=sequence.encode(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            pdb = res.read().decode()
    except urllib.error.HTTPError as err:
        body = err.read().decode(errors="replace")[:500]
        raise RunnerError("remote_api_error", f"ESM Atlas said HTTP {err.code}: {body}", retryable=err.code >= 500) from None
    except (urllib.error.URLError, TimeoutError) as err:
        raise RunnerError("remote_api_unreachable", f"Couldn't reach ESM Atlas: {err}", retryable=True) from None

    # ESM Atlas writes pLDDT as 0-1; everything downstream expects 0-100 (AlphaFold convention).
    raw = ca_bfactors(pdb)
    if not raw:
        raise RunnerError("empty_output", "The API returned a structure with no residues.", retryable=True)
    factor = 100.0 if max(raw) <= 1.0 else 1.0
    plddt = [round(v * factor, 2) for v in raw]
    (outdir / "model_1.pdb").write_text(scale_bfactors(pdb, factor))
    mean = sum(plddt) / len(plddt)
    (outdir / "scores_1.json").write_text(json.dumps({"plddt": plddt, "mean_plddt": round(mean, 2)}))
    log(f"Folded: mean pLDDT {mean:.1f}")
    return Result(
        outputs=[
            Output("model_1.pdb", "structure", "chemical/x-pdb", rank=1),
            Output("scores_1.json", "scores", "application/json", rank=1),
        ],
        metrics={"meanPlddt": round(mean, 2)},
        model_version="esmfold_v1 (api.esmatlas.com)",
        notes={"bfactor_scale": str(factor)},
    )

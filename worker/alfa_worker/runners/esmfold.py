"""
ESMFold on the local GPU via Hugging Face transformers. This is what runs in
a Colab or molab session. Single chains only; complexes go to ColabFold.
"""

from __future__ import annotations

import json
from pathlib import Path

from . import Output, Result, RunnerError

CAPABILITIES = {"models": ["esmfold"], "max_residues": 800}
WEIGHTS = "facebook/esmfold_v1"


def run(job: dict, outdir: Path, log) -> Result:
    chains = job["chains"]
    if len(chains) != 1:
        raise RunnerError("unsupported_mode", "ESMFold here folds single chains only.")
    sequence = chains[0]["sequence"]

    import torch
    from transformers import AutoTokenizer, EsmForProteinFolding

    if not torch.cuda.is_available():
        raise RunnerError("no_gpu", "This session has no GPU attached.", retryable=True)
    log(f"GPU: {torch.cuda.get_device_name(0)}")
    log(f"Loading {WEIGHTS}")
    tokenizer = AutoTokenizer.from_pretrained(WEIGHTS)
    model = EsmForProteinFolding.from_pretrained(WEIGHTS, low_cpu_mem_usage=True).cuda().eval()
    model.esm = model.esm.half()
    # Chunking trades speed for memory; 64 keeps ~800 residues inside a 16 GB T4.
    model.trunk.set_chunk_size(64 if len(sequence) > 400 else None)

    log(f"Folding {len(sequence)} residues")
    inputs = tokenizer([sequence], return_tensors="pt", add_special_tokens=False)
    try:
        with torch.no_grad():
            out = model(**{k: v.cuda() for k, v in inputs.items()})
    except torch.cuda.OutOfMemoryError:
        raise RunnerError(
            "gpu_oom", f"{len(sequence)} residues is too long for this GPU's memory.", retryable=False
        ) from None

    pdb = model.output_to_pdb(out)[0]
    plddt = [round(float(v) * 100, 2) for v in out["plddt"][0, :, 1].cpu()]  # atom37 index 1 = CA
    pae = out["predicted_aligned_error"][0].cpu().float()
    ptm = float(out["ptm"])
    mean = sum(plddt) / len(plddt)

    (outdir / "model_1.pdb").write_text(pdb)
    (outdir / "scores_1.json").write_text(
        json.dumps({"plddt": plddt, "mean_plddt": round(mean, 2), "ptm": round(ptm, 4)})
    )
    (outdir / "pae_1.json").write_text(
        json.dumps({"max_pae": round(float(out["max_predicted_aligned_error"]), 2),
                    "pae": [[round(float(x), 1) for x in row] for row in pae]})
    )
    log(f"Folded: mean pLDDT {mean:.1f}, pTM {ptm:.3f}")

    import transformers

    return Result(
        outputs=[
            Output("model_1.pdb", "structure", "chemical/x-pdb", rank=1),
            Output("scores_1.json", "scores", "application/json", rank=1),
            Output("pae_1.json", "pae", "application/json", rank=1),
        ],
        metrics={"meanPlddt": round(mean, 2), "ptm": round(ptm, 4)},
        model_version=f"{WEIGHTS} (transformers {transformers.__version__}, torch {torch.__version__})",
    )

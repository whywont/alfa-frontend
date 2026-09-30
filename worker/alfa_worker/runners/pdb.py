"""Small PDB helpers: pull per-residue pLDDT from B-factors, and normalize its scale."""

from __future__ import annotations


def ca_bfactors(pdb: str) -> list[float]:
    """B-factor of each residue's CA atom, in chain/residue order."""
    values = []
    for line in pdb.splitlines():
        if line.startswith("ATOM") and line[12:16].strip() == "CA":
            values.append(float(line[60:66]))
    return values


def scale_bfactors(pdb: str, factor: float) -> str:
    """Multiply every ATOM/HETATM B-factor, keeping PDB column widths."""
    out = []
    for line in pdb.splitlines():
        if line.startswith(("ATOM", "HETATM")) and len(line) >= 66:
            value = min(float(line[60:66]) * factor, 999.99)
            line = f"{line[:60]}{value:6.2f}{line[66:]}"
        out.append(line)
    return "\n".join(out) + "\n"

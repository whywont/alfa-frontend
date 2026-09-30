# Plan

Building to the brief in `rse-takehome-2026/tasks/03-alphafold-frontend.md`.

- [x] **Phase 0: handoff spike.** Queue + state machine (tested), worker API,
  Python worker, local storage, Colab notebook. Real folds end to end;
  eviction recovery verified with `kill -9`.
- [ ] **Deploy.** Vercel + Neon + R2 so a Colab worker can reach the server.
  First real fold on a Colab T4.
- [ ] **Phase 1: queue polish.** User-facing error messages per error code,
  retry button, cancel-all, per-lab quotas, retention cleanup job.
- [ ] **Phase 2: submit.** FASTA upload and multi-file batch upload, length
  limits, "already folded" dedupe via `input_hash`, time and cost estimate,
  monomer/complex and fast/thorough.
- [ ] **Phase 3: results.** Mol* viewer colored by pLDDT, PAE heatmap, ranked
  model tabs, batch triage table sorted by confidence, zip download, image
  and data export.
- [ ] **ColabFold runner.** Multimers, 5 ranked models, ipTM; reuse the MSA
  and uploaded models on retry.
- [ ] **Phase 4: auth.** GitHub OIDC, owner/lab authorization, sharing.
- [ ] **Phase 5: demo data.** Seed a batch of real folds (monomers, a known
  dimer, a disordered protein).
- [ ] **Phase 6: extras.** SLURM design note, Modal stub, completion email or
  webhook, MCP server, PDB lookup and RMSD.

# Architecture

## The handoff: workers pull, leases expire

The GPU lives in a free notebook session (Colab, molab) that may not exist
when a job is submitted, can't accept inbound connections, and dies without
warning. So the server never tries to reach it. Instead, a small worker
process runs *inside* the notebook and does everything over outbound HTTPS:

```
 browser ──submit──▶ Alfa (Next.js + Postgres) ◀──claim / heartbeat / complete── worker (in notebook)
                            │                                                        │
                            └──── signed upload URL ────▶ object storage ◀─── PUT ────┘
```

1. **Submit.** A job is a row in `jobs`, state `queued`. No GPU needs to exist.
2. **Claim.** A worker calls `POST /api/worker/claim` with what it can run
   (models, max residues). It gets one job and a **lease** of 120 s, recorded
   as a row in `job_attempts`.
3. **Heartbeat.** Every 15 s the worker renews the lease and ships new log
   lines. The response carries `cancel: true` if the user cancelled; the
   worker then kills the child process doing the fold.
4. **Upload.** Outputs go straight to storage through signed URLs (not through
   the API, so a large PAE matrix doesn't hit serverless body limits), then
   get committed as `artifacts` rows tied to the attempt.
5. **Complete or fail.** The worker reports metrics and provenance, or an
   error code with a `retryable` flag.
6. **Session dies.** Heartbeats stop, the lease expires, and the sweeper
   (run on every claim, and by cron) marks the attempt `expired` and requeues
   the job with backoff (30 s, 2 m, 8 m, 30 m). The next worker to show up
   takes it as attempt 2. A zombie worker that wakes up later gets `409` on
   everything, because its lease token no longer matches.

Verified end to end locally: `kill -9` on a worker mid-job → job back in
`queued` 120 s later → a fresh worker finished it as attempt 2, and both
attempts are on record.

### Why this beat the alternatives

- **Push through a tunnel (ngrok, cloudflared) into the notebook.** Requires
  inbound reachability, a URL that changes every session, and a server that
  knows which sessions are alive. It works exactly while the tab is open.
- **A shared bucket or Google Drive folder as the queue.** No atomic claim, so
  two sessions can take the same job; no leases, so a dead session's job is
  stuck until someone notices; and auth to a user's Drive is its own mess.
- **Driving Colab from the server** (browser automation, unofficial APIs).
  Fragile, and against Colab's terms.
- **Server-invoked serverless GPU (Modal).** A good backend, but it costs
  money and isn't the free ephemeral compute the brief is about. It fits the
  same seam: Modal would just start a worker.

Pull + leases also suits the rest of the design: the web app runs on
serverless functions that can't hold connections open, and Postgres already
gives us atomic claims.

## Backends are ways of starting a worker

Every backend runs the same worker and speaks the same claim/lease/upload
protocol. What differs is only *how a worker comes to exist*:

| Backend | Starts a worker by | Status |
|---|---|---|
| Colab / molab | a person runs the notebook (or leaves it running) | real |
| Local | `python -m alfa_worker` on a lab machine | real |
| SLURM | `sbatch` of a job script that runs the worker with `--once` | design (see `slurm.md`, coming) |
| Modal | the server calls a Modal function that runs the worker | stub (coming) |

Runners (`worker/alfa_worker/runners/`) are the other axis: which model runs.
`esmfold` uses the local GPU; `esmatlas` calls Meta's public ESMFold API and
exists so the whole pipeline can be exercised from a laptop.

`esmatlas` is for development and testing only. Meta hosts it for free with
no SLA, published rate limits, or key; it caps input at 400 residues and one
chain, returns no PAE, and sends the sequence to a third party. It could
disappear any day. Real jobs run on the `esmfold` runner on a GPU we control
(Colab, molab, a lab machine).

## Provenance

Each artifact belongs to an attempt, and each attempt records the backend,
worker host, GPU, worker version and git SHA, runner, and exact model version.
The job records the input sequences, their hash, and the parameters. Every
state change is in `job_events` with a reason. Storage keys are
`jobs/YYYY/MM/<job>/attempt-<n>/<file>`, so files from a retried job never
overwrite the earlier attempt's.

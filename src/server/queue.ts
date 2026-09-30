/**
 * The job queue and its state machine.
 *
 *            claim                  complete
 *   queued ─────────▶ running ─────────────────▶ succeeded
 *     ▲  │              │  │  fail (permanent / out of retries)
 *     │  │ cancel       │  └───────────────────▶ failed
 *     │  ▼              │ cancel
 *     │ cancelled ◀── cancelling  (worker acks, or its lease runs out)
 *     │                 │
 *     └─────────────────┘ lease expired or retryable failure, with backoff
 *
 * Workers pull: they claim a job, hold it with a lease they renew by
 * heartbeat, and lose it if they go quiet. Nothing here needs to reach a
 * worker, which is what lets the GPU live in a notebook we can't connect to.
 *
 * Every function takes `now` so tests control the clock.
 */
import { newId, randomToken, sha256 } from "../lib/ids.ts";
import type { Db, Queryable } from "./db";

export type JobState = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export type Model = "esmfold" | "colabfold";

export interface Chain {
  id: string;
  sequence: string;
}

export interface NewJob {
  ownerId: string;
  name: string;
  model: Model;
  mode: "monomer" | "complex";
  preset: "fast" | "thorough";
  chains: Chain[];
  batchId?: string;
  priority?: number;
  params?: Record<string, unknown>;
}

export interface Job {
  id: string;
  owner_id: string;
  batch_id: string | null;
  name: string;
  model: Model;
  mode: "monomer" | "complex";
  preset: "fast" | "thorough";
  chains: Chain[];
  total_residues: number;
  input_hash: string;
  params: Record<string, unknown>;
  state: JobState;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  current_attempt_id: string | null;
  error_code: string | null;
  error_message: string | null;
  mean_plddt: number | null;
  ptm: number | null;
  iptm: number | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface Attempt {
  id: string;
  job_id: string;
  attempt_no: number;
  worker_id: string;
  backend: string;
  lease_token: string;
  lease_expires_at: Date;
  state: "running" | "succeeded" | "failed" | "expired" | "cancelled";
}

export const LEASE_SECONDS = 120;
export const HEARTBEAT_SECONDS = 15;
export const MAX_RUNNING_PER_OWNER = 2;

/** 30s, 2m, 8m, 30m, 30m... Long enough that a fresh GPU session has time to show up. */
export function backoffSeconds(attempt: number): number {
  return Math.min(30 * 4 ** Math.max(attempt - 1, 0), 30 * 60);
}

export function inputHash(job: Pick<NewJob, "model" | "preset" | "chains">): string {
  const canonical = JSON.stringify({
    model: job.model,
    preset: job.preset,
    chains: job.chains.map((c) => c.sequence.toUpperCase()),
  });
  return sha256(canonical);
}

const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

async function recordEvent(
  q: Queryable,
  jobId: string,
  attemptId: string | null,
  now: Date,
  from: JobState | null,
  to: JobState,
  reason: string,
): Promise<void> {
  await q.query(
    "insert into job_events (job_id, attempt_id, at, from_state, to_state, reason) values ($1, $2, $3, $4, $5, $6)",
    [jobId, attemptId, now, from, to, reason],
  );
}

export async function createJob(db: Db, input: NewJob, now: Date): Promise<Job> {
  const id = newId("job");
  const totalResidues = input.chains.reduce((n, c) => n + c.sequence.length, 0);
  return db.tx(async (q) => {
    const [job] = await q.query<Job>(
      `insert into jobs (id, owner_id, batch_id, name, model, mode, preset, chains, total_residues,
                         input_hash, params, state, priority, run_after, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', $12, $13, $13, $13)
       returning *`,
      [
        id,
        input.ownerId,
        input.batchId ?? null,
        input.name,
        input.model,
        input.mode,
        input.preset,
        JSON.stringify(input.chains),
        totalResidues,
        inputHash(input),
        JSON.stringify(input.params ?? {}),
        input.priority ?? 0,
        now,
      ],
    );
    await recordEvent(q, id, null, now, null, "queued", "Submitted");
    return job;
  });
}

export interface ClaimRequest {
  workerId: string;
  backend: string;
  models: Model[];
  maxResidues: number;
  workerInfo?: Record<string, unknown>;
}

export interface ClaimedJob {
  job: Job;
  attempt: Attempt;
}

/**
 * Hand the next job to a worker, or null if there's nothing it can run.
 *
 * Owners with fewer running jobs go first, so one person's 200-sequence batch
 * interleaves with everyone else's work instead of blocking it. Claims are
 * serialized with an advisory lock: they're rare (one per job), and it keeps
 * the per-owner running count exact.
 */
export async function claim(db: Db, req: ClaimRequest, now: Date): Promise<ClaimedJob | null> {
  await sweepExpiredLeases(db, now);
  return db.tx(async (q) => {
    await q.query("select pg_advisory_xact_lock(7340001)");
    const [candidate] = await q.query<Job>(
      `select j.* from jobs j
       left join (
         select owner_id, count(*)::int as n from jobs
         where state in ('running', 'cancelling') group by owner_id
       ) r on r.owner_id = j.owner_id
       where j.state = 'queued'
         and j.run_after <= $1
         and j.model = any($2::text[])
         and j.total_residues <= $3
         and coalesce(r.n, 0) < $4
       order by coalesce(r.n, 0), j.priority desc, j.created_at
       limit 1`,
      [now, req.models, req.maxResidues, MAX_RUNNING_PER_OWNER],
    );
    if (!candidate) return null;

    const attemptNo = candidate.attempts + 1;
    const [attempt] = await q.query<Attempt>(
      `insert into job_attempts (id, job_id, attempt_no, worker_id, backend, lease_token,
                                 lease_expires_at, state, worker_info, started_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'running', $8, $9)
       returning *`,
      [
        newId("att"),
        candidate.id,
        attemptNo,
        req.workerId,
        req.backend,
        randomToken(),
        addSeconds(now, LEASE_SECONDS),
        JSON.stringify(req.workerInfo ?? {}),
        now,
      ],
    );
    const [job] = await q.query<Job>(
      `update jobs set state = 'running', attempts = $2, current_attempt_id = $3,
              started_at = coalesce(started_at, $4), updated_at = $4
       where id = $1 returning *`,
      [candidate.id, attemptNo, attempt.id, now],
    );
    await recordEvent(q, job.id, attempt.id, now, "queued", "running", `Started on ${req.backend} (attempt ${attemptNo})`);
    await q.query("update workers set last_seen_at = $2 where id = $1", [req.workerId, now]);
    return { job, attempt };
  });
}

export interface Lease {
  jobId: string;
  attemptId: string;
  leaseToken: string;
}

export class LeaseLostError extends Error {
  constructor() {
    super("This worker no longer holds the job's lease.");
  }
}

/** Lock and return the attempt and job, or throw if the caller's lease is no longer valid. */
async function holdLease(q: Queryable, lease: Lease, now: Date): Promise<{ job: Job; attempt: Attempt }> {
  const [attempt] = await q.query<Attempt>(
    "select * from job_attempts where id = $1 and job_id = $2 for update",
    [lease.attemptId, lease.jobId],
  );
  if (!attempt || attempt.lease_token !== lease.leaseToken || attempt.state !== "running" || attempt.lease_expires_at <= now) {
    throw new LeaseLostError();
  }
  const [job] = await q.query<Job>("select * from jobs where id = $1 for update", [lease.jobId]);
  if (job.current_attempt_id !== attempt.id) throw new LeaseLostError();
  return { job, attempt };
}

export interface HeartbeatResult {
  cancel: boolean;
  leaseExpiresAt: Date;
}

export async function heartbeat(
  db: Db,
  lease: Lease,
  update: { logs?: string[]; progress?: Record<string, unknown> },
  now: Date,
): Promise<HeartbeatResult> {
  return db.tx(async (q) => {
    const { job } = await holdLease(q, lease, now);
    const leaseExpiresAt = addSeconds(now, LEASE_SECONDS);
    await q.query(
      "update job_attempts set lease_expires_at = $2, progress = coalesce($3, progress) where id = $1",
      [lease.attemptId, leaseExpiresAt, update.progress ? JSON.stringify(update.progress) : null],
    );
    for (const line of update.logs ?? []) {
      await q.query("insert into job_logs (job_id, attempt_id, at, line) values ($1, $2, $3, $4)", [
        lease.jobId,
        lease.attemptId,
        now,
        line.slice(0, 4000),
      ]);
    }
    return { cancel: job.state === "cancelling", leaseExpiresAt };
  });
}

export interface Metrics {
  meanPlddt?: number;
  ptm?: number;
  iptm?: number;
}

export async function complete(
  db: Db,
  lease: Lease,
  metrics: Metrics,
  now: Date,
  provenance: Record<string, unknown> = {},
): Promise<JobState> {
  return db.tx(async (q) => {
    const { job } = await holdLease(q, lease, now);
    const [{ n }] = await q.query<{ n: number }>(
      "select count(*)::int as n from artifacts where attempt_id = $1 and kind = 'structure'",
      [lease.attemptId],
    );
    if (n === 0) throw new Error("Attempt reported success without uploading a structure.");

    // A cancel that arrives after the fold finished still wins: the user asked to stop.
    // The artifacts stay attached to the attempt until retention cleanup.
    const to: JobState = job.state === "cancelling" ? "cancelled" : "succeeded";
    // Provenance the worker only learns while running (exact model weights, library versions).
    await q.query(
      "update job_attempts set state = $2, ended_at = $3, worker_info = worker_info || $4::jsonb where id = $1",
      [lease.attemptId, to === "cancelled" ? "cancelled" : "succeeded", now, JSON.stringify(provenance)],
    );
    await q.query(
      `update jobs set state = $2, mean_plddt = $3, ptm = $4, iptm = $5, finished_at = $6, updated_at = $6,
              error_code = null, error_message = null
       where id = $1`,
      [job.id, to, metrics.meanPlddt ?? null, metrics.ptm ?? null, metrics.iptm ?? null, now],
    );
    await recordEvent(q, job.id, lease.attemptId, now, job.state, to, to === "succeeded" ? "Finished" : "Cancelled after finishing");
    return to;
  });
}

export interface Failure {
  code: string;
  message: string;
  retryable: boolean;
}

export async function fail(db: Db, lease: Lease, failure: Failure, now: Date): Promise<JobState> {
  return db.tx(async (q) => {
    const { job } = await holdLease(q, lease, now);
    const cancelled = job.state === "cancelling" || failure.code === "cancelled";
    await q.query(
      "update job_attempts set state = $2, error_code = $3, error_message = $4, ended_at = $5 where id = $1",
      [lease.attemptId, cancelled ? "cancelled" : "failed", failure.code, failure.message, now],
    );
    return endAttempt(q, job, lease.attemptId, now, cancelled ? { cancelled: true } : { failure });
  });
}

/**
 * Decide where a job goes after its current attempt ends without success:
 * cancelled, back to the queue with backoff, or failed for good.
 */
async function endAttempt(
  q: Queryable,
  job: Job,
  attemptId: string,
  now: Date,
  outcome: { cancelled: true } | { failure: Failure },
): Promise<JobState> {
  if ("cancelled" in outcome) {
    await q.query(
      "update jobs set state = 'cancelled', current_attempt_id = null, finished_at = $2, updated_at = $2 where id = $1",
      [job.id, now],
    );
    await recordEvent(q, job.id, attemptId, now, job.state, "cancelled", "Cancelled");
    return "cancelled";
  }
  const { failure } = outcome;
  if (failure.retryable && job.attempts < job.max_attempts) {
    const delay = backoffSeconds(job.attempts);
    await q.query(
      `update jobs set state = 'queued', current_attempt_id = null, run_after = $2, updated_at = $3,
              error_code = $4, error_message = $5
       where id = $1`,
      [job.id, addSeconds(now, delay), now, failure.code, failure.message],
    );
    await recordEvent(q, job.id, attemptId, now, job.state, "queued", `${failure.message} Retrying in ${delay}s.`);
    return "queued";
  }
  await q.query(
    `update jobs set state = 'failed', current_attempt_id = null, finished_at = $2, updated_at = $2,
            error_code = $3, error_message = $4
     where id = $1`,
    [job.id, now, failure.code, failure.message],
  );
  await recordEvent(q, job.id, attemptId, now, job.state, "failed", failure.message);
  return "failed";
}

/**
 * Attempts whose worker stopped heartbeating. The usual cause is a notebook
 * session being torn down; the job goes back in the queue for the next worker.
 */
export async function sweepExpiredLeases(db: Db, now: Date): Promise<number> {
  return db.tx(async (q) => {
    const expired = await q.query<Attempt>(
      "select * from job_attempts where state = 'running' and lease_expires_at <= $1 for update skip locked",
      [now],
    );
    for (const attempt of expired) {
      await q.query(
        "update job_attempts set state = 'expired', error_code = 'worker_lost', ended_at = $2 where id = $1",
        [attempt.id, now],
      );
      const [job] = await q.query<Job>("select * from jobs where id = $1 for update", [attempt.job_id]);
      if (job.current_attempt_id !== attempt.id) continue;
      await endAttempt(
        q,
        job,
        attempt.id,
        now,
        job.state === "cancelling"
          ? { cancelled: true }
          : {
              failure: {
                code: "worker_lost",
                message: "The GPU session running this job went away.",
                retryable: true,
              },
            },
      );
    }
    return expired.length;
  });
}

/** Queued jobs cancel immediately; running ones are flagged and stop at the worker's next heartbeat. */
export async function cancel(db: Db, jobId: string, ownerId: string, now: Date): Promise<JobState | null> {
  return db.tx(async (q) => {
    const [job] = await q.query<Job>("select * from jobs where id = $1 and owner_id = $2 for update", [jobId, ownerId]);
    if (!job) return null;
    if (job.state === "queued") {
      await q.query("update jobs set state = 'cancelled', finished_at = $2, updated_at = $2 where id = $1", [jobId, now]);
      await recordEvent(q, jobId, null, now, "queued", "cancelled", "Cancelled before it started");
      return "cancelled";
    }
    if (job.state === "running") {
      await q.query("update jobs set state = 'cancelling', updated_at = $2 where id = $1", [jobId, now]);
      await recordEvent(q, jobId, job.current_attempt_id, now, "running", "cancelling", "Cancel requested");
      return "cancelling";
    }
    return job.state;
  });
}

/** Cancel everything an owner has in flight, in one transaction. */
export async function cancelAll(db: Db, ownerId: string, now: Date): Promise<number> {
  return db.tx(async (q) => {
    const jobs = await q.query<Job>(
      "select * from jobs where owner_id = $1 and state in ('queued', 'running') for update",
      [ownerId],
    );
    for (const job of jobs) {
      const to = job.state === "queued" ? "cancelled" : "cancelling";
      await q.query(
        `update jobs set state = $2, updated_at = $3, finished_at = case when $2 = 'cancelled' then $3 else finished_at end
         where id = $1`,
        [job.id, to, now],
      );
      await recordEvent(q, job.id, job.current_attempt_id, now, job.state, to, "Cancelled (cancel all)");
    }
    return jobs.length;
  });
}

export interface ArtifactInput {
  name: string;
  kind: "structure" | "scores" | "pae" | "msa" | "log" | "other";
  rank?: number;
  contentType: string;
  bytes: number;
  sha256: string;
}

/** Where an attempt's files live. Dated by job creation so old jobs group together for cleanup. */
export function storageKey(job: Pick<Job, "id" | "created_at">, attemptNo: number, name: string): string {
  const d = new Date(job.created_at);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `jobs/${yyyy}/${mm}/${job.id}/attempt-${attemptNo}/${name}`;
}

export function validArtifactName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);
}

/** Check the lease and return where the worker should upload `name`. */
export async function artifactKey(db: Db, lease: Lease, name: string, now: Date): Promise<string> {
  if (!validArtifactName(name)) throw new Error(`Invalid artifact name: ${name}`);
  return db.tx(async (q) => {
    const { job, attempt } = await holdLease(q, lease, now);
    return storageKey(job, attempt.attempt_no, name);
  });
}

/** Record a file the worker has uploaded. Idempotent, so a retried commit is harmless. */
export async function commitArtifact(db: Db, lease: Lease, input: ArtifactInput, now: Date): Promise<string> {
  if (!validArtifactName(input.name)) throw new Error(`Invalid artifact name: ${input.name}`);
  return db.tx(async (q) => {
    const { job, attempt } = await holdLease(q, lease, now);
    const key = storageKey(job, attempt.attempt_no, input.name);
    await q.query(
      `insert into artifacts (id, job_id, attempt_id, name, kind, rank, storage_key, content_type, bytes, sha256, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (attempt_id, name) do update
         set kind = excluded.kind, rank = excluded.rank, content_type = excluded.content_type,
             bytes = excluded.bytes, sha256 = excluded.sha256`,
      [newId("art"), job.id, attempt.id, input.name, input.kind, input.rank ?? null, key, input.contentType, input.bytes, input.sha256, now],
    );
    return key;
  });
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openPglite } from "@/server/db";
import {
  type ClaimRequest,
  type Lease,
  LEASE_SECONDS,
  LeaseLostError,
  MAX_RUNNING_PER_OWNER,
  type NewJob,
  cancel,
  cancelAll,
  claim,
  commitArtifact,
  complete,
  createJob,
  fail,
  heartbeat,
  sweepExpiredLeases,
} from "@/server/queue";

let db: Db;
let now: Date;
const tick = (seconds: number) => {
  now = new Date(now.getTime() + seconds * 1000);
  return now;
};

const worker: ClaimRequest = { workerId: "wkr_test", backend: "colab", models: ["esmfold"], maxResidues: 1000 };

const job = (overrides: Partial<NewJob> = {}): NewJob => ({
  ownerId: "alice",
  name: "ubiquitin",
  model: "esmfold",
  mode: "monomer",
  preset: "fast",
  chains: [{ id: "A", sequence: "MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG" }],
  ...overrides,
});

const leaseOf = (c: { job: { id: string }; attempt: { id: string; lease_token: string } }): Lease => ({
  jobId: c.job.id,
  attemptId: c.attempt.id,
  leaseToken: c.attempt.lease_token,
});

async function uploadStructure(lease: Lease) {
  await commitArtifact(
    db,
    lease,
    { name: "model_1.pdb", kind: "structure", rank: 1, contentType: "chemical/x-pdb", bytes: 10, sha256: "x" },
    now,
  );
}

async function state(jobId: string) {
  const [row] = await db.query<{ state: string; attempts: number; error_code: string | null }>(
    "select state, attempts, error_code from jobs where id = $1",
    [jobId],
  );
  return row;
}

beforeEach(async () => {
  db = await openPglite();
  now = new Date("2026-09-25T12:00:00Z");
});
afterEach(() => db.close());

describe("happy path", () => {
  it("claims, heartbeats, uploads, and completes", async () => {
    const created = await createJob(db, job(), now);
    const claimed = await claim(db, worker, tick(1));
    expect(claimed?.job.id).toBe(created.id);
    const lease = leaseOf(claimed!);

    const hb = await heartbeat(db, lease, { logs: ["loading weights"] }, tick(10));
    expect(hb.cancel).toBe(false);

    await uploadStructure(lease);
    expect(await complete(db, lease, { meanPlddt: 88.2 }, tick(5))).toBe("succeeded");
    expect((await state(created.id)).state).toBe("succeeded");
  });

  it("won't mark success without a structure", async () => {
    await createJob(db, job(), now);
    const lease = leaseOf((await claim(db, worker, now))!);
    await expect(complete(db, lease, {}, now)).rejects.toThrow(/without uploading a structure/);
  });

  it("returns nothing when the queue is empty or the model doesn't match", async () => {
    expect(await claim(db, worker, now)).toBeNull();
    await createJob(db, job({ model: "colabfold" }), now);
    expect(await claim(db, worker, now)).toBeNull();
  });

  it("skips jobs too long for the worker's GPU", async () => {
    await createJob(db, job(), now);
    expect(await claim(db, { ...worker, maxResidues: 10 }, now)).toBeNull();
  });
});

describe("session dies mid-job", () => {
  it("requeues with backoff when the lease expires, then a new worker picks it up", async () => {
    const created = await createJob(db, job(), now);
    const first = leaseOf((await claim(db, worker, now))!);

    tick(LEASE_SECONDS + 1);
    expect(await sweepExpiredLeases(db, now)).toBe(1);
    expect(await state(created.id)).toMatchObject({ state: "queued", error_code: "worker_lost" });

    // Backoff: not claimable right away.
    expect(await claim(db, worker, tick(1))).toBeNull();
    const second = await claim(db, { ...worker, workerId: "wkr_fresh" }, tick(60));
    expect(second?.attempt.attempt_no).toBe(2);

    // The dead worker's lease is useless now, even if it comes back.
    await expect(heartbeat(db, first, {}, now)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(uploadStructure(first)).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("gives up after max attempts", async () => {
    const created = await createJob(db, job(), now);
    for (let i = 0; i < 5; i++) {
      const c = await claim(db, worker, tick(3600));
      expect(c).not.toBeNull();
      tick(LEASE_SECONDS + 1);
      await sweepExpiredLeases(db, now);
    }
    expect(await state(created.id)).toMatchObject({ state: "failed", attempts: 5, error_code: "worker_lost" });
  });

  it("keeps a job alive as long as heartbeats arrive", async () => {
    const created = await createJob(db, job(), now);
    const lease = leaseOf((await claim(db, worker, now))!);
    for (let i = 0; i < 20; i++) await heartbeat(db, lease, {}, tick(LEASE_SECONDS / 2));
    await sweepExpiredLeases(db, now);
    expect((await state(created.id)).state).toBe("running");
  });
});

describe("failures", () => {
  it("retries retryable failures", async () => {
    const created = await createJob(db, job(), now);
    const lease = leaseOf((await claim(db, worker, now))!);
    const to = await fail(db, lease, { code: "msa_server_busy", message: "The MSA server was busy.", retryable: true }, now);
    expect(to).toBe("queued");
    expect((await state(created.id)).error_code).toBe("msa_server_busy");
  });

  it("fails permanent errors immediately", async () => {
    const created = await createJob(db, job(), now);
    const lease = leaseOf((await claim(db, worker, now))!);
    await fail(db, lease, { code: "gpu_oom", message: "Too long for this GPU.", retryable: false }, now);
    expect(await state(created.id)).toMatchObject({ state: "failed", error_code: "gpu_oom" });
  });
});

describe("cancellation", () => {
  it("cancels a queued job immediately", async () => {
    const created = await createJob(db, job(), now);
    expect(await cancel(db, created.id, "alice", now)).toBe("cancelled");
    expect(await claim(db, worker, now)).toBeNull();
  });

  it("only lets the owner cancel", async () => {
    const created = await createJob(db, job(), now);
    expect(await cancel(db, created.id, "mallory", now)).toBeNull();
    expect((await state(created.id)).state).toBe("queued");
  });

  it("tells the worker to stop at the next heartbeat, and the worker acks", async () => {
    const created = await createJob(db, job(), now);
    const lease = leaseOf((await claim(db, worker, now))!);
    expect(await cancel(db, created.id, "alice", now)).toBe("cancelling");
    expect((await heartbeat(db, lease, {}, tick(5))).cancel).toBe(true);
    await fail(db, lease, { code: "cancelled", message: "Stopped", retryable: false }, now);
    expect((await state(created.id)).state).toBe("cancelled");
  });

  it("finishes cancelling if the worker dies instead of acking", async () => {
    const created = await createJob(db, job(), now);
    await claim(db, worker, now);
    await cancel(db, created.id, "alice", now);
    tick(LEASE_SECONDS + 1);
    await sweepExpiredLeases(db, now);
    expect((await state(created.id)).state).toBe("cancelled");
  });

  it("a cancel that races a finished fold still wins", async () => {
    const created = await createJob(db, job(), now);
    const lease = leaseOf((await claim(db, worker, now))!);
    await cancel(db, created.id, "alice", now);
    await uploadStructure(lease);
    expect(await complete(db, lease, {}, now)).toBe("cancelled");
  });

  it("cancel all handles queued and running together", async () => {
    for (let i = 0; i < 4; i++) await createJob(db, job({ name: `seq ${i}` }), now);
    await claim(db, worker, now);
    expect(await cancelAll(db, "alice", now)).toBe(4);
    const rows = await db.query<{ state: string }>("select state from jobs order by state");
    expect(rows.map((r) => r.state)).toEqual(["cancelled", "cancelled", "cancelled", "cancelling"]);
  });
});

describe("fairness", () => {
  it(`caps each owner at ${MAX_RUNNING_PER_OWNER} running jobs and serves other owners first`, async () => {
    for (let i = 0; i < 10; i++) await createJob(db, job({ name: `alice ${i}` }), now);
    tick(1);
    await createJob(db, job({ ownerId: "bob", name: "bob 0" }), now);

    const owners: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await claim(db, { ...worker, workerId: `w${i}` }, now);
      owners.push(c?.job.owner_id ?? "none");
    }
    // Alice goes first (older), then Bob (fewer running), then Alice hits her cap.
    expect(owners).toEqual(["alice", "bob", "alice", "none"]);
  });

  it("respects priority within an owner", async () => {
    await createJob(db, job({ name: "low" }), now);
    await createJob(db, job({ name: "high", priority: 10 }), now);
    expect((await claim(db, worker, now))?.job.name).toBe("high");
  });
});

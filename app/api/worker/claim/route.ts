import { claim, HEARTBEAT_SECONDS, type Model } from "@/server/queue";
import { json, withWorker } from "@/server/workerApi";

/** A worker asks for its next job. 204 means nothing to do; poll again later. */
export function POST(request: Request) {
  return withWorker(request, async ({ db, worker, body }) => {
    const models = Array.isArray(body.models) ? (body.models as Model[]) : [];
    const maxResidues = typeof body.maxResidues === "number" ? body.maxResidues : 400;
    const claimed = await claim(
      db,
      {
        workerId: worker.id,
        backend: typeof body.backend === "string" ? body.backend : worker.backend,
        models,
        maxResidues,
        workerInfo: (body.workerInfo as Record<string, unknown>) ?? {},
      },
      new Date(),
    );
    if (!claimed) return new Response(null, { status: 204 });
    const { job, attempt } = claimed;
    return json({
      jobId: job.id,
      attemptId: attempt.id,
      attemptNo: attempt.attempt_no,
      leaseToken: attempt.lease_token,
      leaseExpiresAt: attempt.lease_expires_at,
      heartbeatSeconds: HEARTBEAT_SECONDS,
      job: {
        name: job.name,
        model: job.model,
        mode: job.mode,
        preset: job.preset,
        chains: job.chains,
        params: job.params,
      },
    });
  });
}

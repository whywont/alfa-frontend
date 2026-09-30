/** Shared plumbing for the /api/worker routes. */
import { getDb, type Db } from "./db";
import { type Lease, LeaseLostError } from "./queue";
import { authenticateWorker, type Worker } from "./workerAuth";

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** Authenticate the worker, run the handler, and map queue errors to HTTP. */
export async function withWorker(
  request: Request,
  handler: (ctx: { db: Db; worker: Worker; body: Record<string, unknown> }) => Promise<Response>,
): Promise<Response> {
  const db = await getDb();
  const worker = await authenticateWorker(db, request);
  if (!worker) return json({ error: "unauthorized" }, 401);
  let body: Record<string, unknown> = {};
  if (request.method !== "GET") {
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
  }
  try {
    return await handler({ db, worker, body });
  } catch (err) {
    // 409 tells the worker to drop the job: someone else owns it now.
    if (err instanceof LeaseLostError) return json({ error: "lease_lost" }, 409);
    console.error(err);
    return json({ error: "server_error", message: (err as Error).message }, 500);
  }
}

export function leaseFrom(body: Record<string, unknown>): Lease {
  const { jobId, attemptId, leaseToken } = body;
  if (typeof jobId !== "string" || typeof attemptId !== "string" || typeof leaseToken !== "string") {
    throw new LeaseLostError();
  }
  return { jobId, attemptId, leaseToken };
}

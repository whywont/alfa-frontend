import { heartbeat } from "@/server/queue";
import { json, leaseFrom, withWorker } from "@/server/workerApi";

/** Renew the lease, append log lines, and learn whether the user cancelled. */
export function POST(request: Request) {
  return withWorker(request, async ({ db, body }) => {
    const logs = Array.isArray(body.logs) ? body.logs.filter((l): l is string => typeof l === "string") : [];
    const result = await heartbeat(
      db,
      leaseFrom(body),
      { logs: logs.slice(0, 500), progress: body.progress as Record<string, unknown> | undefined },
      new Date(),
    );
    return json(result);
  });
}

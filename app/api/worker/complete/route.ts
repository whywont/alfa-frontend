import { complete, type Metrics } from "@/server/queue";
import { json, leaseFrom, withWorker } from "@/server/workerApi";

export function POST(request: Request) {
  return withWorker(request, async ({ db, body }) => {
    const metrics = (body.metrics ?? {}) as Metrics;
    const provenance = (body.provenance ?? {}) as Record<string, unknown>;
    return json({ state: await complete(db, leaseFrom(body), metrics, new Date(), provenance) });
  });
}

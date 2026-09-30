import { fail } from "@/server/queue";
import { json, leaseFrom, withWorker } from "@/server/workerApi";

export function POST(request: Request) {
  return withWorker(request, async ({ db, body }) => {
    const failure = {
      code: typeof body.code === "string" ? body.code : "unknown",
      message: typeof body.message === "string" ? body.message.slice(0, 2000) : "The worker reported an error.",
      retryable: body.retryable === true,
    };
    return json({ state: await fail(db, leaseFrom(body), failure, new Date()) });
  });
}

import { artifactKey } from "@/server/queue";
import { getStorage } from "@/server/storage";
import { json, leaseFrom, withWorker } from "@/server/workerApi";

/** Where to PUT one output file. The worker uploads directly, then commits it. */
export function POST(request: Request) {
  return withWorker(request, async ({ db, body }) => {
    if (typeof body.name !== "string") return json({ error: "name required" }, 400);
    const key = await artifactKey(db, leaseFrom(body), body.name, new Date());
    return json({ url: await getStorage().uploadUrl(key, 15 * 60), method: "PUT" });
  });
}

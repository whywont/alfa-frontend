import { type ArtifactInput, artifactKey, commitArtifact } from "@/server/queue";
import { getStorage } from "@/server/storage";
import { json, leaseFrom, withWorker } from "@/server/workerApi";

const KINDS = new Set(["structure", "scores", "pae", "msa", "log", "other"]);

/** Record an uploaded file against the attempt. Checks it actually landed in storage. */
export function POST(request: Request) {
  return withWorker(request, async ({ db, body }) => {
    const lease = leaseFrom(body);
    const { name, kind, rank, contentType, sha256 } = body;
    if (typeof name !== "string" || typeof kind !== "string" || !KINDS.has(kind) || typeof sha256 !== "string") {
      return json({ error: "name, kind, and sha256 required" }, 400);
    }
    const now = new Date();
    const size = await getStorage().size(await artifactKey(db, lease, name, now));
    if (size === null) return json({ error: "not_uploaded" }, 409);
    const input: ArtifactInput = {
      name,
      kind: kind as ArtifactInput["kind"],
      rank: typeof rank === "number" ? rank : undefined,
      contentType: typeof contentType === "string" ? contentType : "application/octet-stream",
      bytes: size,
      sha256,
    };
    return json({ key: await commitArtifact(db, lease, input, now) });
  });
}

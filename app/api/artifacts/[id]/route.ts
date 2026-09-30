import { getDb } from "@/server/db";
import { getStorage } from "@/server/storage";
import { currentUserId } from "@/server/session";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  const [artifact] = await db.query<{ name: string; storage_key: string; content_type: string }>(
    `select a.name, a.storage_key, a.content_type from artifacts a join jobs j on j.id = a.job_id
     where a.id = $1 and j.owner_id = $2`,
    [id, await currentUserId()],
  );
  if (!artifact) return new Response(null, { status: 404 });
  const storage = getStorage();
  if (storage.downloadUrl) {
    // Send the browser straight to R2 rather than streaming through a serverless function.
    return Response.redirect(await storage.downloadUrl(artifact.storage_key, artifact.name, 300), 302);
  }
  return new Response(await storage.read(artifact.storage_key), {
    headers: {
      "content-type": artifact.content_type,
      "content-disposition": `inline; filename="${artifact.name}"`,
    },
  });
}

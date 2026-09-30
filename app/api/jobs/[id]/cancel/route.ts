import { getDb } from "@/server/db";
import { cancel } from "@/server/queue";
import { currentUserId } from "@/server/session";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const state = await cancel(await getDb(), id, await currentUserId(), new Date());
  if (!state) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ state });
}

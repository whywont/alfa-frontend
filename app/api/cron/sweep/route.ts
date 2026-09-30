import { getDb } from "@/server/db";
import { sweepExpiredLeases } from "@/server/queue";

/**
 * Requeue jobs whose worker went quiet. Claims also sweep, so this only
 * matters when no worker is polling; it keeps the UI's states honest then.
 */
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected && request.headers.get("authorization") !== `Bearer ${expected}`) {
    return new Response(null, { status: 401 });
  }
  const swept = await sweepExpiredLeases(await getDb(), new Date());
  return Response.json({ swept });
}

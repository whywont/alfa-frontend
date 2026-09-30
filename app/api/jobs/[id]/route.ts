import { getDb } from "@/server/db";
import type { Job } from "@/server/queue";
import { currentUserId } from "@/server/session";

/** Everything about one job: its attempts, history, logs, and outputs. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  const [job] = await db.query<Job>("select * from jobs where id = $1 and owner_id = $2", [id, await currentUserId()]);
  if (!job) return Response.json({ error: "not_found" }, { status: 404 });
  const [attempts, events, logs, artifacts] = await Promise.all([
    db.query(
      `select id, attempt_no, backend, state, worker_info, progress, error_code, error_message, started_at, ended_at
       from job_attempts where job_id = $1 order by attempt_no`,
      [id],
    ),
    db.query("select at, from_state, to_state, reason, attempt_id from job_events where job_id = $1 order by id", [id]),
    db.query("select at, attempt_id, line from job_logs where job_id = $1 order by id desc limit 1000", [id]),
    db.query(
      "select id, attempt_id, name, kind, rank, content_type, bytes, sha256 from artifacts where job_id = $1 order by name",
      [id],
    ),
  ]);
  return Response.json({ job, attempts, events, logs: logs.reverse(), artifacts });
}

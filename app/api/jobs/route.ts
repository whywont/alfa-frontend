import { parseFasta } from "@/lib/fasta";
import { newId } from "@/lib/ids";
import { getDb } from "@/server/db";
import { createJob, type Job } from "@/server/queue";
import { currentUserId } from "@/server/session";

export async function GET() {
  const db = await getDb();
  const jobs = await db.query<Job>(
    `select id, name, model, mode, preset, state, total_residues, attempts, error_code, error_message,
            mean_plddt, ptm, iptm, created_at, finished_at
     from jobs where owner_id = $1 order by created_at desc limit 500`,
    [await currentUserId()],
  );
  return Response.json({ jobs });
}

/** Submit FASTA text. One job per record; records with ':' are complexes. */
export async function POST(request: Request) {
  const { fasta, preset = "fast" } = (await request.json()) as { fasta?: string; preset?: "fast" | "thorough" };
  const { records, problems } = parseFasta(fasta ?? "");
  if (problems.length) return Response.json({ problems }, { status: 422 });
  if (!records.length) return Response.json({ problems: [{ record: "", message: "No sequences found." }] }, { status: 422 });

  const db = await getDb();
  const ownerId = await currentUserId();
  const batchId = records.length > 1 ? newId("batch") : undefined;
  const now = new Date();
  const jobs = [];
  for (const record of records) {
    const complex = record.chains.length > 1;
    jobs.push(
      await createJob(
        db,
        {
          ownerId,
          batchId,
          name: record.name,
          // ESMFold only does single chains; complexes and "thorough" need ColabFold.
          model: complex || preset === "thorough" ? "colabfold" : "esmfold",
          mode: complex ? "complex" : "monomer",
          preset,
          chains: record.chains.map((sequence, i) => ({ id: String.fromCharCode(65 + i), sequence })),
        },
        now,
      ),
    );
  }
  return Response.json({ batchId, jobs: jobs.map((j) => ({ id: j.id, name: j.name, model: j.model })) }, { status: 201 });
}

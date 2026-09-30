/**
 * Worker credentials.
 *
 * A worker token lets a notebook claim jobs and upload results, nothing more:
 * it can't list jobs, read other results, or act as a user. It's stored
 * hashed, and pasted into the notebook as a secret. Revoking it strands the
 * worker, whose jobs then requeue when their leases expire.
 */
import { newId, randomToken, sha256 } from "../lib/ids.ts";
import type { Db } from "./db";

export interface Worker {
  id: string;
  label: string;
  backend: string;
}

export async function createWorkerToken(
  db: Db,
  label: string,
  backend: string,
  now: Date,
): Promise<{ worker: Worker; token: string }> {
  const id = newId("wkr");
  const token = `alfa_wkr_${randomToken()}`;
  await db.query(
    "insert into workers (id, label, backend, token_hash, created_at) values ($1, $2, $3, $4, $5)",
    [id, label, backend, sha256(token), now],
  );
  return { worker: { id, label, backend }, token };
}

export async function authenticateWorker(db: Db, request: Request): Promise<Worker | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const [worker] = await db.query<Worker>(
    "select id, label, backend from workers where token_hash = $1 and revoked_at is null",
    [sha256(token)],
  );
  return worker ?? null;
}

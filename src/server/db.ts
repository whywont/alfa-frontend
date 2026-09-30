import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** The slice of a Postgres client the app uses. Both PGlite and node-postgres fit it. */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  tx<R>(fn: (q: Queryable) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

/** PGlite, in memory (tests) or persisted to a directory (local dev). */
export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const pg = new PGlite(dataDir);
  const db: Db = {
    async query(text, params) {
      return (await pg.query(text, params)).rows as never;
    },
    tx(fn) {
      return pg.transaction((t) =>
        fn({ query: async (text, params) => (await t.query(text, params)).rows as never }),
      );
    },
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}

/** node-postgres against Neon or any Postgres. */
export async function openPostgres(url: string): Promise<Db> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url, max: 5 });
  const db: Db = {
    async query(text, params) {
      return (await pool.query(text, params as unknown[])).rows;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn({
          query: async (text, params) => (await client.query(text, params as unknown[])).rows,
        });
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  await migrate(db);
  return db;
}

async function migrate(db: Db): Promise<void> {
  await db.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const applied = new Set(
    (await db.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name),
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await db.tx(async (q) => {
      // Two serverless cold starts can race here; the lock makes the loser wait, then skip.
      await q.query("select pg_advisory_xact_lock(7340000)");
      const [done] = await q.query("select 1 from schema_migrations where name = $1", [file]);
      if (done) return;
      for (const statement of splitStatements(sql)) await q.query(statement);
      await q.query("insert into schema_migrations (name) values ($1)", [file]);
    });
  }
}

/** Migrations are plain DDL; split on semicolons at line ends, ignoring comments. */
function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

let shared: Promise<Db> | undefined;

/** The app's database. Unset DATABASE_URL means embedded PGlite under .data/. */
export function getDb(): Promise<Db> {
  shared ??= process.env.DATABASE_URL
    ? openPostgres(process.env.DATABASE_URL)
    : openPglite(path.join(process.cwd(), ".data", "pglite"));
  return shared;
}

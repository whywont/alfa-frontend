/**
 * Mint a worker token: `pnpm worker:token "andrew's colab" colab`.
 * Paste the printed token into the notebook's secrets as ALFA_WORKER_TOKEN.
 */
import { getDb } from "../src/server/db.ts";
import { createWorkerToken } from "../src/server/workerAuth.ts";

const [label = "worker", backend = "colab"] = process.argv.slice(2);
const db = await getDb();
const { worker, token } = await createWorkerToken(db, label, backend, new Date());
console.log(`Worker ${worker.id} (${backend}, "${label}")`);
console.log(`ALFA_WORKER_TOKEN=${token}`);
await db.close();

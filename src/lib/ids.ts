import { createHash, randomBytes } from "node:crypto";

/** Short, roughly time-sortable ids: `job_lxk2m9a1_4f9c2e`. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

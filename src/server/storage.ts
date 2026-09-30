/**
 * Object storage for job artifacts.
 *
 * Workers never send file bytes through the queue API. They ask for an upload
 * URL and PUT straight to storage, so a large PAE matrix doesn't hit
 * serverless body limits. Locally, "straight to storage" is a signed URL back
 * into this app (see app/api/storage). In production it's an S3/R2 presigned
 * URL, behind the same interface.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export interface Storage {
  /** A URL the worker can PUT the file to, valid for `ttlSeconds`. */
  uploadUrl(key: string, ttlSeconds: number): Promise<string>;
  /** Size in bytes, or null if the object doesn't exist. */
  size(key: string): Promise<number | null>;
  read(key: string): Promise<ReadableStream<Uint8Array>>;
  /** A short-lived URL the browser can download from directly, if the store supports it. */
  downloadUrl?(key: string, filename: string, ttlSeconds: number): Promise<string>;
  remove(prefix: string): Promise<void>;
}

const ROOT = path.join(process.cwd(), ".data", "storage");

function secret(): string {
  const s = process.env.STORAGE_SECRET;
  if (!s && process.env.NODE_ENV === "production") throw new Error("STORAGE_SECRET is not set");
  return s ?? "dev-only-storage-secret";
}

function sign(key: string, expires: number): string {
  return createHmac("sha256", secret()).update(`${key}\n${expires}`).digest("base64url");
}

export function verifyUploadSignature(key: string, expires: number, signature: string, now: Date): boolean {
  if (!Number.isFinite(expires) || expires * 1000 < now.getTime()) return false;
  const expected = Buffer.from(sign(key, expires));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function localPath(key: string): string {
  const resolved = path.resolve(ROOT, key);
  if (!resolved.startsWith(ROOT + path.sep)) throw new Error(`Storage key escapes root: ${key}`);
  return resolved;
}

export const localStorage: Storage & { write(key: string, data: Uint8Array): Promise<void> } = {
  async uploadUrl(key, ttlSeconds) {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const base = process.env.PUBLIC_URL ?? "http://localhost:3000";
    const params = new URLSearchParams({ key, expires: String(expires), sig: sign(key, expires) });
    return `${base}/api/storage/upload?${params}`;
  },
  async size(key) {
    try {
      return (await stat(localPath(key))).size;
    } catch {
      return null;
    }
  },
  async read(key) {
    return Readable.toWeb(createReadStream(localPath(key))) as ReadableStream<Uint8Array>;
  },
  async remove(prefix) {
    await rm(localPath(prefix), { recursive: true, force: true });
  },
  async write(key, data) {
    const file = localPath(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  },
};

/**
 * Cloudflare R2 (or any S3-compatible store). Files never pass through the
 * app: workers PUT to presigned URLs and browsers GET from them.
 */
export function s3Storage(config: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Storage {
  const client = (async () => {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  })();
  const Bucket = config.bucket;
  return {
    async uploadUrl(key, ttlSeconds) {
      const [{ PutObjectCommand }, { getSignedUrl }] = await Promise.all([
        import("@aws-sdk/client-s3"),
        import("@aws-sdk/s3-request-presigner"),
      ]);
      return getSignedUrl(await client, new PutObjectCommand({ Bucket, Key: key }), { expiresIn: ttlSeconds });
    },
    async downloadUrl(key, filename, ttlSeconds) {
      const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([
        import("@aws-sdk/client-s3"),
        import("@aws-sdk/s3-request-presigner"),
      ]);
      const command = new GetObjectCommand({
        Bucket,
        Key: key,
        ResponseContentDisposition: `inline; filename="${filename}"`,
      });
      return getSignedUrl(await client, command, { expiresIn: ttlSeconds });
    },
    async size(key) {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      try {
        const head = await (await client).send(new HeadObjectCommand({ Bucket, Key: key }));
        return head.ContentLength ?? 0;
      } catch (err) {
        if ((err as { name?: string }).name === "NotFound") return null;
        throw err;
      }
    },
    async read(key) {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const res = await (await client).send(new GetObjectCommand({ Bucket, Key: key }));
      return res.Body!.transformToWebStream();
    },
    async remove(prefix) {
      const { ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
      const s3 = await client;
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
        if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys } }));
        token = page.NextContinuationToken;
      } while (token);
    },
  };
}

let shared: Storage | undefined;

/** R2 when S3_BUCKET is set, otherwise files under .data/storage. */
export function getStorage(): Storage {
  if (shared) return shared;
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
  shared =
    S3_BUCKET && S3_ENDPOINT && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY
      ? s3Storage({
          endpoint: S3_ENDPOINT,
          bucket: S3_BUCKET,
          accessKeyId: S3_ACCESS_KEY_ID,
          secretAccessKey: S3_SECRET_ACCESS_KEY,
        })
      : localStorage;
  return shared;
}

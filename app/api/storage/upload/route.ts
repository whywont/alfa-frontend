import { localStorage, verifyUploadSignature } from "@/server/storage";

/** Local-dev stand-in for an S3/R2 presigned PUT. */
export async function PUT(request: Request) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") ?? "";
  const expires = Number(url.searchParams.get("expires"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!verifyUploadSignature(key, expires, sig, new Date())) {
    return Response.json({ error: "bad_signature" }, { status: 403 });
  }
  await localStorage.write(key, new Uint8Array(await request.arrayBuffer()));
  return new Response(null, { status: 200 });
}

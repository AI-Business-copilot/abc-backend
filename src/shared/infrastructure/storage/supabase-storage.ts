import { HttpError } from "../../http/http-error";

/**
 * Minimal Supabase Storage client (REST, service-role key).
 * Only the backend talks to Storage; the browser never reads or writes objects directly.
 */

const SIGNED_URL_TTL_SECONDS = 300;
const MAX_OBJECT_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

let bucketReady: Promise<void> | null = null;

function config() {
  const baseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) {
    throw new HttpError(503, "Image storage is not configured on the server.");
  }
  return {
    baseUrl,
    serviceKey,
    bucket: process.env.SUPABASE_STORAGE_BUCKET?.trim() || "scrap-evidence",
  };
}

function headers(serviceKey: string, extra: Record<string, string> = {}) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, ...extra };
}

/** Encode each path segment but keep the slashes. */
function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function storageFetch(url: URL, init: RequestInit): Promise<globalThis.Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new HttpError(503, "Image storage could not be reached.");
  }
}

async function createBucketIfMissing(): Promise<void> {
  const { baseUrl, serviceKey, bucket } = config();

  const lookup = await storageFetch(
    new URL(`/storage/v1/bucket/${encodeURIComponent(bucket)}`, baseUrl),
    { headers: headers(serviceKey) },
  );
  if (lookup.ok) return;

  const create = await storageFetch(new URL("/storage/v1/bucket", baseUrl), {
    method: "POST",
    headers: headers(serviceKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      id: bucket,
      name: bucket,
      public: false,
      file_size_limit: MAX_OBJECT_BYTES,
      allowed_mime_types: ALLOWED_MIME_TYPES,
    }),
  });

  // 409 means another request created it between our lookup and create.
  if (!create.ok && create.status !== 409) {
    throw new HttpError(503, "Image storage bucket could not be prepared.");
  }
}

/** Creates the private bucket once per process. A failed attempt is retried on the next upload. */
export function ensureBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = createBucketIfMissing().catch((error) => {
      bucketReady = null;
      throw error;
    });
  }
  return bucketReady;
}

export async function uploadObject(path: string, body: Buffer, contentType: string): Promise<void> {
  await ensureBucket();
  const { baseUrl, serviceKey, bucket } = config();

  const response = await storageFetch(
    new URL(`/storage/v1/object/${encodeURIComponent(bucket)}/${encodePath(path)}`, baseUrl),
    {
      method: "POST",
      headers: headers(serviceKey, { "Content-Type": contentType, "x-upsert": "false" }),
      body: new Uint8Array(body),
    },
  );
  if (!response.ok) {
    throw new HttpError(503, "The image could not be saved to storage.");
  }
}

/** Best effort: failures are logged and never thrown, so cleanup never hides the real error. */
export async function deleteObjects(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    const { baseUrl, serviceKey, bucket } = config();
    const response = await storageFetch(
      new URL(`/storage/v1/object/${encodeURIComponent(bucket)}`, baseUrl),
      {
        method: "DELETE",
        headers: headers(serviceKey, { "Content-Type": "application/json" }),
        body: JSON.stringify({ prefixes: paths }),
      },
    );
    if (!response.ok) {
      console.warn("Storage cleanup failed.", { status: response.status, count: paths.length });
    }
  } catch (error) {
    console.warn("Storage cleanup failed.", error);
  }
}

/** Returns a short-lived signed URL for each path, keyed by path. Missing objects get no entry. */
export async function createSignedUrls(paths: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (paths.length === 0) return result;

  const { baseUrl, serviceKey, bucket } = config();
  const response = await storageFetch(
    new URL(`/storage/v1/object/sign/${encodeURIComponent(bucket)}`, baseUrl),
    {
      method: "POST",
      headers: headers(serviceKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS, paths }),
    },
  );
  if (!response.ok) {
    throw new HttpError(503, "Image links could not be created.");
  }

  const entries = (await response.json()) as Array<{
    path?: string;
    signedURL?: string | null;
    error?: string | null;
  }>;
  for (const entry of entries) {
    if (entry.path && entry.signedURL && !entry.error) {
      // signedURL is relative to /storage/v1 and already carries the token.
      result.set(entry.path, new URL(`/storage/v1${entry.signedURL}`, baseUrl).toString());
    }
  }
  return result;
}

export const STORAGE_LIMITS = { maxBytes: MAX_OBJECT_BYTES, allowedMimeTypes: ALLOWED_MIME_TYPES };

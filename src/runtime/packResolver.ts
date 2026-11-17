/**
 * Resolve packed asset references into playable URLs.
 *
 * A packed manifest URL looks like:
 *
 *   /pack/voices_0008-004-1a2b3c4d5e6f.pack#123456-147890:ogg
 *
 * `start` is inclusive and `end` is exclusive. One HTTP `Range` request
 * fetches only the clip. If the host ignores `Range` (200 instead of 206) the
 * full archive is fetched once, cached, and sliced locally. In-flight requests
 * for the same clip are shared, and resolved blob URLs are kept in a bounded
 * LRU so repeat voice lines and images cost no extra read operations.
 *
 * Plain URLs (development mode, or large WAVs kept as individual objects)
 * pass through unchanged.
 */

export type PackedAssetKind = "image" | "audio" | "voice" | "binary";

type CacheLimits = {
  /** Maximum total bytes of resolved Blob URLs kept alive. */
  maxBytes: number;
  /** Maximum number of resolved Blob URLs kept alive. */
  maxEntries: number;
  /** Maximum number of full archives kept for non-Range fallback. */
  maxChunks: number;
  /** Maximum bytes of full archives kept for non-Range fallback. */
  maxChunkBytes: number;
};

const DEFAULT_LIMITS: CacheLimits = {
  maxBytes: 96 * 1024 * 1024,
  maxEntries: 512,
  maxChunks: 6,
  maxChunkBytes: 64 * 1024 * 1024,
};

let limits: CacheLimits = { ...DEFAULT_LIMITS };
let blobBytes = 0;
let chunkBytes = 0;

const blobUrls = new Map<string, { url: string; size: number }>();
const inflight = new Map<string, Promise<string>>();
const chunks = new Map<string, ArrayBuffer>();
const chunkInflight = new Map<string, Promise<ArrayBuffer | null>>();
// Archives that answered a Range request with 200. Once known, read the
// cached full chunk instead of repeating a doomed Range request per clip.
const rangeUnsupported = new Set<string>();

const PACK_REF_RE = /^(.+)#(\d+)-(\d+)(?::([a-z0-9]+))?$/i;

const MIME_BY_CODEC: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  json: "application/json",
};

function mimeFor(codec: string | undefined, kind: PackedAssetKind): string {
  if (codec && MIME_BY_CODEC[codec.toLowerCase()]) return MIME_BY_CODEC[codec.toLowerCase()];
  if (kind === "image") return "image/png";
  if (kind === "audio") return "audio/wav";
  if (kind === "voice") return "audio/ogg";
  return "application/octet-stream";
}

function isBlobUrlAvailable(): boolean {
  return typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}

function revoke(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    // A revoked or unknown URL is harmless.
  }
}

function evictBlobs(): void {
  while (
    blobUrls.size > 0
    && (blobUrls.size > limits.maxEntries || (blobBytes > limits.maxBytes && blobUrls.size > 1))
  ) {
    const oldest = blobUrls.keys().next().value;
    if (oldest === undefined) break;
    const entry = blobUrls.get(oldest);
    blobUrls.delete(oldest);
    if (entry) {
      blobBytes = Math.max(0, blobBytes - entry.size);
      revoke(entry.url);
    }
  }
}

function rememberBlob(key: string, url: string, size: number): void {
  const previous = blobUrls.get(key);
  if (previous) {
    blobBytes = Math.max(0, blobBytes - previous.size);
    revoke(previous.url);
    blobUrls.delete(key);
  }
  blobUrls.set(key, { url, size });
  blobBytes += size;
  evictBlobs();
}

function touchBlob(key: string): { url: string; size: number } | undefined {
  const entry = blobUrls.get(key);
  if (!entry) return undefined;
  blobUrls.delete(key);
  blobUrls.set(key, entry);
  return entry;
}

function rememberChunk(archive: string, buffer: ArrayBuffer): void {
  const previous = chunks.get(archive);
  if (previous) {
    chunkBytes = Math.max(0, chunkBytes - previous.byteLength);
    chunks.delete(archive);
  }
  chunks.set(archive, buffer);
  chunkBytes += buffer.byteLength;
  while (chunks.size > 0 && (chunks.size > limits.maxChunks || (chunkBytes > limits.maxChunkBytes && chunks.size > 1))) {
    const oldest = chunks.keys().next().value;
    if (oldest === undefined) break;
    const entry = chunks.get(oldest);
    chunks.delete(oldest);
    if (entry) chunkBytes = Math.max(0, chunkBytes - entry.byteLength);
  }
}

function touchChunk(archive: string): ArrayBuffer | undefined {
  const entry = chunks.get(archive);
  if (!entry) return undefined;
  chunks.delete(archive);
  chunks.set(archive, entry);
  return entry;
}

async function fetchWholeChunk(archive: string): Promise<ArrayBuffer | null> {
  const cached = touchChunk(archive);
  if (cached) return cached;
  const pending = chunkInflight.get(archive);
  if (pending) return pending;
  const request = (async () => {
    try {
      const response = await fetch(archive, { cache: "force-cache" });
      if (!response.ok) return null;
      const buffer = await response.arrayBuffer();
      rememberChunk(archive, buffer);
      return buffer;
    } catch {
      return null;
    }
  })();
  chunkInflight.set(archive, request);
  try {
    return await request;
  } finally {
    chunkInflight.delete(archive);
  }
}

function contentRangeMatches(header: string | null, start: number, end: number): boolean {
  if (!header) return true;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!match) return false;
  return Number(match[1]) === start && Number(match[2]) === end - 1;
}

async function fetchRange(
  archive: string,
  start: number,
  end: number,
): Promise<{ slice: ArrayBuffer; whole?: ArrayBuffer } | null> {
  try {
    const response = await fetch(archive, {
      headers: { Range: `bytes=${start}-${end - 1}` },
      cache: "force-cache",
    });
    if (response.status === 206) {
      if (!contentRangeMatches(response.headers.get("content-range"), start, end)) return null;
      const body = await response.arrayBuffer();
      // A proxy that returns the wrong number of bytes would decode as
      // garbage. Reject it and use the full-chunk fallback instead.
      if (body.byteLength !== end - start) return null;
      return { slice: body };
    }
    if (response.ok) {
      const whole = await response.arrayBuffer();
      if (end > whole.byteLength) return null;
      rememberChunk(archive, whole);
      return { slice: whole.slice(start, end), whole };
    }
    return null;
  } catch {
    return null;
  }
}

async function resolvePacked(
  url: string,
  match: RegExpExecArray,
  kind: PackedAssetKind,
): Promise<string> {
  const cached = touchBlob(url);
  if (cached) return cached.url;
  const pending = inflight.get(url);
  if (pending) return pending;

  const [, archive, startText, endText, codec] = match;
  const start = Number(startText);
  const end = Number(endText);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    throw new Error(`Invalid packed asset range: ${url}`);
  }
  if (!isBlobUrlAvailable()) throw new Error("This browser cannot create Blob URLs for packed assets.");

  const request = (async () => {
    let slice: ArrayBuffer | null = null;
    if (!rangeUnsupported.has(archive)) {
      const ranged = await fetchRange(archive, start, end);
      if (ranged) {
        slice = ranged.slice;
        if (ranged.whole) rangeUnsupported.add(archive);
      }
    }
    if (!slice) {
      const whole = await fetchWholeChunk(archive);
      if (!whole || end > whole.byteLength) {
        throw new Error(`Unable to read bytes ${start}-${end} from ${archive}`);
      }
      slice = whole.slice(start, end);
    }
    const expected = end - start;
    if (!slice || slice.byteLength !== expected) {
      throw new Error(`Packed asset returned ${slice?.byteLength ?? 0} bytes, expected ${expected}: ${url}`);
    }
    const blob = new Blob([slice], { type: mimeFor(codec, kind) });
    const objectUrl = URL.createObjectURL(blob);
    rememberBlob(url, objectUrl, blob.size);
    return objectUrl;
  })();

  inflight.set(url, request);
  try {
    return await request;
  } finally {
    inflight.delete(url);
  }
}

/** True when the URL uses the packed `archive#start-end[:codec]` form. */
export function isPackedRef(url: string | null | undefined): boolean {
  return typeof url === "string" && PACK_REF_RE.test(url);
}

/**
 * Resolve any manifest asset URL. Plain URLs (dev mode, individual WAVs) are
 * returned unchanged; packed refs become Blob URLs of the exact byte range.
 */
export async function resolveAssetUrl(url: string, kind: PackedAssetKind = "binary"): Promise<string> {
  if (!url) return url;
  const match = PACK_REF_RE.exec(url);
  if (!match) return url;
  return resolvePacked(url, match, kind);
}

/** Resolve an audio/voice URL; large WAVs normally pass through unchanged. */
export function resolveAudioUrl(url: string): Promise<string> {
  return resolveAssetUrl(url, "audio");
}

/** Drop every cached Blob URL and full-chunk buffer. Safe to call on teardown. */
export function clearPackCaches(): void {
  for (const entry of blobUrls.values()) revoke(entry.url);
  blobUrls.clear();
  blobBytes = 0;
  chunks.clear();
  chunkBytes = 0;
  inflight.clear();
  chunkInflight.clear();
  rangeUnsupported.clear();
}

/** Adjust cache limits (tests and low-memory devices). */
export function configurePackCache(next: Partial<CacheLimits>): void {
  limits = { ...limits, ...next };
  evictBlobs();
  while (chunks.size > 0 && (chunks.size > limits.maxChunks || (chunkBytes > limits.maxChunkBytes && chunks.size > 1))) {
    const oldest = chunks.keys().next().value;
    if (oldest === undefined) break;
    const entry = chunks.get(oldest);
    chunks.delete(oldest);
    if (entry) chunkBytes = Math.max(0, chunkBytes - entry.byteLength);
  }
}

/** Current cache accounting, primarily for diagnostics and tests. */
export function packCacheStatus(): { entries: number; bytes: number; chunks: number; chunkBytes: number; inflight: number } {
  return { entries: blobUrls.size, bytes: blobBytes, chunks: chunks.size, chunkBytes, inflight: inflight.size };
}

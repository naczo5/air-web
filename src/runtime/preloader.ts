/**
 * Shared asset warm-up cache.
 *
 * Two places need to warm the same assets: the runtime announces what the next
 * lines need (`prefetch` events), and the stage paints them. Keeping one cache
 * here means a warm and a paint share a single range request instead of each
 * issuing its own — on packed data every duplicate is a wasted round trip.
 *
 * Nothing here paints; it only makes `preloadImage` resolve instantly later.
 */

const imageState = new Map<string, "pending" | "ready" | "error">();
const imagePending = new Map<string, Promise<boolean>>();
/**
 * In-flight audio resolutions only.
 *
 * Deliberately NOT a cache of settled results: `packResolver` owns the blob-URL
 * LRU and may revoke a URL at any point, so handing a remembered URL back as
 * "warm" would play a dead object URL. Keeping only in-flight promises means a
 * prefetch and a play share one request, while a later play re-resolves through
 * the layer that actually owns the cache.
 */
const audioPending = new Map<string, Promise<string | null>>();

/** Bounded so a long session cannot retain every bitmap it ever saw. */
const IMAGE_CACHE_MAX = 192;

/** Resolve true once the bitmap can be painted. Never throws. */
export function preloadImage(url: string | undefined | null): Promise<boolean> {
  if (!url) return Promise.resolve(false);
  const state = imageState.get(url);
  if (state === "ready") return Promise.resolve(true);
  if (state === "error") return Promise.resolve(false);
  const inflight = imagePending.get(url);
  if (inflight) return inflight;
  if (typeof Image === "undefined") return Promise.resolve(false);

  imageState.set(url, "pending");
  const request = new Promise<boolean>((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = url;
  }).then((ok) => {
    imageState.set(url, ok ? "ready" : "error");
    imagePending.delete(url);
    // Evict oldest finished entries; never evict an in-flight one.
    while (imageState.size > IMAGE_CACHE_MAX) {
      const oldest = imageState.keys().next().value;
      if (oldest === undefined) break;
      if (imageState.get(oldest) === "pending") break;
      imageState.delete(oldest);
    }
    return ok;
  });
  imagePending.set(url, request);
  return request;
}

/** True when the bitmap is decoded and ready to paint without a fetch. */
export function isImageReady(url: string | undefined | null): boolean {
  return Boolean(url) && imageState.get(url!) === "ready";
}

/**
 * Start (or join) the fetch for an audio ref. Resolving the packed range ahead
 * of playback is what removes the pause after a line appears.
 *
 * The entry is removed once settled — this is a de-duplicator for concurrent
 * callers, not a result cache. `packResolver` owns the blob-URL LRU and may
 * revoke a URL at any time, so remembering one here would hand out a dead URL.
 * A failure is also evicted, so a transient error cannot silence a clip.
 */
export function preloadAudioUrl(url: string | undefined | null, resolve: (value: string) => Promise<string>): Promise<string | null> {
  if (!url) return Promise.resolve(null);
  const inflight = audioPending.get(url);
  if (inflight) return inflight;
  const request = resolve(url).catch(() => null).finally(() => { audioPending.delete(url); });
  audioPending.set(url, request);
  return request;
}

/**
 * A fetch already in flight for this ref, so a play that arrives while the
 * prefetch is still running joins it instead of issuing a second request.
 */
export function warmedAudioUrl(url: string | undefined | null): Promise<string | null> | undefined {
  return url ? audioPending.get(url) : undefined;
}

/** Test/teardown helper. */
export function clearPreloadCache(): void {
  imageState.clear();
  imagePending.clear();
  audioPending.clear();
}

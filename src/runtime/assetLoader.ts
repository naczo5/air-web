import type { AssetManifest, AssetRef } from "../types";
import { resolveAssetUrl, resolveAudioUrl } from "./packResolver";
import { preloadImage } from "./preloader";

/**
 * Decoded-image cache for the stage, backed by the shared preloader so a
 * lookahead warm and an actual paint share one range request.
 *
 * Every packed asset is its own HTTP request, so the cost that matters is the
 * round trip, not the bytes. `preload` issues those requests during the current
 * line; `image` then resolves from memory when the scene paints it.
 */
/**
 * How many decoded bitmaps stay resident.
 *
 * Decoded backdrops, sprite sheets and CGs are the largest thing the player
 * holds in memory (a 640x480 RGBA frame is ~1.2 MB decoded), and a full route
 * touches thousands. The cache exists to avoid re-decoding the current scene's
 * art, not to be a store, so it is capped; an evicted entry is simply decoded
 * again from the (already fetched) image, which costs no network.
 */
const IMAGE_CACHE_MAX = 64;
const AUDIO_ELEMENT_MAX = 32;

export class AssetLoader {
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly imagePending = new Map<string, Promise<HTMLImageElement | undefined>>();
  private readonly audioElements = new Map<string, HTMLAudioElement>();
  private readonly audioSources = new Map<string, Promise<string>>();

  constructor(private readonly manifest: AssetManifest) {}

  getAsset(id: string): AssetRef | undefined {
    return this.manifest[id];
  }

  /** Is this image decoded and paintable right now? */
  has(id: string): boolean {
    return this.images.has(id);
  }

  /** Bounded insertion: drop the least-recently-used decoded bitmaps. */
  private rememberImage(id: string, image: HTMLImageElement): void {
    this.images.delete(id);
    this.images.set(id, image);
    while (this.images.size > IMAGE_CACHE_MAX) {
      const oldest = this.images.keys().next().value;
      if (oldest === undefined) break;
      this.images.delete(oldest);
    }
  }

  /**
   * Decoded image, or undefined when the asset is unknown/not an image.
   * Concurrent calls for the same id join one decode.
   */
  image(id: string): Promise<HTMLImageElement | undefined> {
    const asset = this.manifest[id];
    if (!asset || asset.kind !== "image") return Promise.resolve(undefined);
    const cached = this.images.get(id);
    if (cached) {
      // Refresh recency so the current scene's art is not evicted mid-render.
      this.rememberImage(id, cached);
      return Promise.resolve(cached);
    }
    const pending = this.imagePending.get(id);
    if (pending) return pending;

    const request = (async () => {
      try {
        const source = await resolveAssetUrl(asset.url, "image");
        // Join the preloader's in-flight fetch (it may already be decoded).
        await preloadImage(source);
        const image = new Image();
        image.decoding = "async";
        image.src = source;
        await image.decode();
        this.rememberImage(id, image);
        return image;
      } catch {
        return undefined;
      } finally {
        this.imagePending.delete(id);
      }
    })();
    this.imagePending.set(id, request);
    return request;
  }

  /** Fire-and-forget warm for a manifest asset id; never throws. */
  preload(id: string | undefined): void {
    if (!id) return;
    const asset = this.manifest[id];
    if (!asset || asset.kind !== "image") return;
    if (this.images.has(id) || this.imagePending.has(id)) return;
    void this.image(id);
  }

  /**
   * Audio element with a source resolved in the background. Kept synchronous
   * for existing callers; use `audio()` when the source must be ready first.
   */
  audioElement(id: string): HTMLAudioElement | undefined {
    const asset = this.manifest[id];
    if (!asset || !["audio", "voice"].includes(asset.kind)) return undefined;
    const cached = this.audioElements.get(id);
    if (cached) return cached;
    const element = new Audio();
    element.preload = "auto";
    element.loop = asset.loop ?? false;
    const ready = this.audioSources.get(id) ?? resolveAudioUrl(asset.url).catch(() => "");
    this.audioSources.set(id, ready);
    void ready.then((source) => { if (source) element.src = source; });
    this.audioElements.set(id, element);
    while (this.audioElements.size > AUDIO_ELEMENT_MAX) {
      const oldest = this.audioElements.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.audioElements.get(oldest);
      this.audioElements.delete(oldest);
      try { evicted?.pause(); evicted?.removeAttribute("src"); } catch { /* disposal */ }
    }
    return element;
  }

  /** Fully resolved audio element, including packed byte ranges. */
  async audio(id: string): Promise<HTMLAudioElement | undefined> {
    const element = this.audioElement(id);
    if (!element) return undefined;
    if (!element.src) {
      const asset = this.manifest[id]!;
      const source = await (this.audioSources.get(id) ?? resolveAudioUrl(asset.url));
      if (source) element.src = source;
    }
    return element;
  }
}

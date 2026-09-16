import type { AssetManifest, AssetRef } from "../types";

export class AssetLoader {
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly audio = new Map<string, HTMLAudioElement>();

  constructor(private readonly manifest: AssetManifest) {}

  getAsset(id: string): AssetRef | undefined {
    return this.manifest[id];
  }

  async image(id: string): Promise<HTMLImageElement | undefined> {
    const asset = this.manifest[id];
    if (!asset || asset.kind !== "image") return undefined;
    const cached = this.images.get(id);
    if (cached) return cached;
    const image = new Image();
    image.decoding = "async";
    image.src = asset.url;
    await image.decode();
    this.images.set(id, image);
    return image;
  }

  audioElement(id: string): HTMLAudioElement | undefined {
    const asset = this.manifest[id];
    if (!asset || !["audio", "voice"].includes(asset.kind)) return undefined;
    const cached = this.audio.get(id);
    if (cached) return cached;
    const element = new Audio(asset.url);
    element.preload = "auto";
    element.loop = asset.loop ?? false;
    this.audio.set(id, element);
    return element;
  }
}

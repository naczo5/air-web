import { useEffect, useState, type ImgHTMLAttributes } from "react";
import type { AssetRef } from "../types";
import { isPackedRef, resolveAssetUrl, resolveAudioUrl, type PackedAssetKind } from "./packResolver";

/**
 * Resolve a manifest URL to a usable `<img src>` value. Plain URLs render
 * immediately; packed refs resolve to a Blob URL first.
 */
export function useResolvedAssetUrl(url: string | undefined, kind: PackedAssetKind = "image"): string | undefined {
  const [source, setSource] = useState<string | undefined>(() => (url && !isPackedRef(url) ? url : undefined));
  useEffect(() => {
    let active = true;
    if (!url) {
      setSource(undefined);
      return () => { active = false; };
    }
    if (!isPackedRef(url)) {
      setSource(url);
      return () => { active = false; };
    }
    setSource(undefined);
    void resolveAssetUrl(url, kind)
      .then((resolved) => { if (active) setSource(resolved); })
      .catch(() => { if (active) setSource(undefined); });
    return () => { active = false; };
  }, [kind, url]);
  return source;
}

/**
 * Drop-in `<img>` for a manifest asset.
 *
 * An `<img>` with no `src` renders its `alt` text, so a packed asset that is
 * still being fetched used to show the raw asset name on screen (the title art
 * read as a file name for seconds on a slow uplink). The element is now hidden
 * until the bitmap is decoded, and fades in over the background it sits on.
 */
export function PackedImage({ asset, className, style, ...rest }: { asset: AssetRef } & Omit<ImgHTMLAttributes<HTMLImageElement>, "src">) {
  const source = useResolvedAssetUrl(asset.url, "image");
  const [decoded, setDecoded] = useState(false);

  // A new source means a new decode; drop the old one so we never show a stale
  // frame from the previous asset while the new one loads.
  useEffect(() => { setDecoded(false); }, [source]);

  return (
    <img
      src={source || undefined}
      alt=""
      aria-hidden={rest.alt ? undefined : true}
      className={className}
      style={{
        ...style,
        // Keep layout stable, but never paint the alt text.
        opacity: decoded ? 1 : 0,
        transition: decoded ? "opacity 220ms ease-out" : undefined,
      }}
      onLoad={() => setDecoded(true)}
      onError={() => setDecoded(false)}
      {...rest}
    />
  );
}

/** Drop-in `<img>` for a raw manifest URL (e.g. flowchart thumbnails). */
export function ResolvedImage({ url, kind = "image", className, style, ...rest }: { url: string; kind?: PackedAssetKind } & Omit<ImgHTMLAttributes<HTMLImageElement>, "src">) {
  const source = useResolvedAssetUrl(url, kind);
  const [decoded, setDecoded] = useState(false);
  useEffect(() => { setDecoded(false); }, [source]);
  return (
    <img
      src={source || undefined}
      alt=""
      aria-hidden
      className={className}
      style={{ ...style, opacity: decoded ? 1 : 0, transition: decoded ? "opacity 220ms ease-out" : undefined }}
      onLoad={() => setDecoded(true)}
      {...rest}
    />
  );
}

/**
 * Point an existing `<audio>` element at a manifest URL and play it. Handles
 * both plain URLs and packed ranges. Callers keep control of loop/volume.
 */
export function playPackedAudio(element: HTMLAudioElement, url: string, volume?: number): Promise<void> {
  return resolveAudioUrl(url)
    .then((source) => {
      element.src = source;
      if (volume !== undefined) element.volume = Math.max(0, Math.min(1, volume));
      return element.play().then(() => undefined);
    })
    .catch(() => undefined);
}

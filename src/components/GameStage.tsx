import { useEffect, useRef } from "react";
import type { GameManifest, RuntimeState } from "../types";
import { AssetLoader } from "../runtime/assetLoader";
import { stageObjects } from "../runtime/display";

type Props = {
  manifest: GameManifest;
  state: RuntimeState;
  onClick: () => void;
  /** Shared loader, so prefetch hints and painting use one cache. */
  loader?: AssetLoader;
  /** `settings.showDateCaption`; false hides the drawn date plate (object 83). */
  showDateCaption?: boolean;
  /** Accessible name for the stage; carries the date when the badge is drawn. */
  label?: string;
};

/**
 * Canvas stage.
 *
 * The important behaviour for perceived speed on a slow link is at the bottom:
 * the canvas keeps the last painted frame while new images decode. Previously
 * every state change repainted the paper gradient first, so a backdrop that took
 * seconds to arrive looked like the scene was restarting from blank.
 *
 * Asset warming is not done here — the runtime owns resolution and announces
 * what is coming next (`prefetch` events), and `App` feeds those to the shared
 * loader. Keeping one place that resolves names avoids two implementations
 * drifting apart.
 */
export function GameStage({ manifest, state, onClick, loader, showDateCaption = true, label = "AIR game stage" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loaderRef = useRef<AssetLoader | undefined>(loader);
  if (loader) loaderRef.current = loader;
  if (!loaderRef.current) loaderRef.current = new AssetLoader(manifest.assets);
  /** Whether a real frame has been painted; until then the gradient is fine. */
  const paintedRef = useRef(false);

  const { layers, objects } = state;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = manifest.logicalSize.width;
    canvas.height = manifest.logicalSize.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = false;
    let active = true;
    let frameId: number | undefined = undefined;

    const render = async () => {
      const activeLayers = layers.map((layer, index) => ({ layer, index })).filter(({ layer }) => Boolean(layer.asset));
      // Objects composite over the scene stack; the scene layers own the
      // backdrop and character sprites, the object table owns the chrome.
      const activeObjects = stageObjects(objects, { showDateCaption });
      const [loadedImages, loadedObjects] = await Promise.all([
        Promise.all(
          activeLayers.map(async ({ layer, index }) => {
            try {
              const image = layer.asset ? await loaderRef.current?.image(layer.asset) : undefined;
              return { layer, index, image };
            } catch {
              return { layer, index, image: undefined };
            }
          })
        ),
        Promise.all(
          activeObjects.map(async ({ id, object }) => {
            if (!object.asset) return { object, image: undefined };
            try {
              const image = await loaderRef.current?.image(object.asset);
              return { object, image };
            } catch {
              return { object, image: undefined };
            }
          })
        ),
      ]);

      if (!active) return;

      frameId = requestAnimationFrame(() => {
        if (!active || !canvas || !context) return;
        const hasArt = loadedImages.some(({ image }) => Boolean(image)) || loadedObjects.some(({ image }) => Boolean(image));
        // Paint the empty backdrop only before the first frame lands. After
        // that, a partially-loaded update draws over the previous frame, so the
        // scene never blinks back to blank paper while a backdrop streams in.
        if (!paintedRef.current || !hasArt) {
          context.fillStyle = "#e9e4d7";
          context.fillRect(0, 0, canvas.width, canvas.height);
          const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
          gradient.addColorStop(0, "#c7dce5");
          gradient.addColorStop(0.56, "#eef0e7");
          gradient.addColorStop(1, "#ece4d4");
          context.fillStyle = gradient;
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "rgba(63, 126, 164, 0.14)";
          context.fillRect(0, Math.round(canvas.height * 0.62), canvas.width, Math.round(canvas.height * 0.07));
        }

        for (const { layer, image } of loadedImages) {
          if (!image) {
            // A layer whose art has not arrived yet. Do NOT clear what is
            // already on the canvas: during a scene change the new backdrop is
            // still streaming, and wiping the frame first is what produced the
            // white flash between backgrounds. The previous frame stays until
            // the replacement is decoded.
            continue;
          }
          context.globalAlpha = Math.max(0, Math.min(1, layer.alpha));
          context.drawImage(image, layer.x, layer.y);
          paintedRef.current = true;
        }

        // Objects are drawn with nearest-neighbour scaling and the plate's own
        // alpha channel intact: `drawImage` with a destination rectangle keeps
        // the PNG's per-pixel alpha, which is what makes the leaf flourishes
        // overhang the scene instead of sitting in a box.
        for (const { object, image } of loadedObjects) {
          context.globalAlpha = Math.max(0, Math.min(1, object.alpha));
          if (image) {
            const width = object.width ?? image.naturalWidth;
            const height = object.height ?? image.naturalHeight;
            context.drawImage(image, object.x, object.y, width, height);
          } else if (object.fill) {
            const { r, g, b } = object.fill;
            context.fillStyle = `rgb(${r} ${g} ${b})`;
            context.fillRect(object.x, object.y, object.width ?? canvas.width, object.height ?? 0);
          }
        }
        context.globalAlpha = 1;
      });
    };

    void render();
    return () => {
      active = false;
      if (frameId !== undefined) cancelAnimationFrame(frameId);
    };
  }, [layers, manifest, objects, showDateCaption]);

  return (
    <div className="stage-shell" onClick={onClick} role="application" aria-label={label}>
      <canvas ref={canvasRef} className="game-canvas" />
      <div className="stage-vignette" />
    </div>
  );
}

import { useEffect, useRef } from "react";
import type { GameManifest, RuntimeState } from "../types";
import { AssetLoader } from "../runtime/assetLoader";

type Props = {
  manifest: GameManifest;
  state: RuntimeState;
  onClick: () => void;
};

export function GameStage({ manifest, state, onClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loaderRef = useRef<AssetLoader | undefined>(undefined);

  if (!loaderRef.current) loaderRef.current = new AssetLoader(manifest.assets);

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
      const activeLayers = state.layers.map((layer, index) => ({ layer, index })).filter(({ layer }) => Boolean(layer.asset));
      const loadedImages = await Promise.all(
        activeLayers.map(async ({ layer, index }) => {
          try {
            const image = layer.asset ? await loaderRef.current?.image(layer.asset) : undefined;
            return { layer, index, image };
          } catch {
            return { layer, index, image: undefined };
          }
        })
      );

      if (!active) return;

      frameId = requestAnimationFrame(() => {
        if (!active || !canvas || !context) return;
        context.fillStyle = "#16202b";
        context.fillRect(0, 0, canvas.width, canvas.height);
        const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
        gradient.addColorStop(0, "#1b3141");
        gradient.addColorStop(1, "#05070b");
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);

        for (const { layer, image } of loadedImages) {
          if (!image) continue;
          context.globalAlpha = Math.max(0, Math.min(1, layer.alpha));
          context.drawImage(image, layer.x, layer.y);
        }
        context.globalAlpha = 1;
      });
    };

    void render();
    return () => {
      active = false;
      if (frameId !== undefined) cancelAnimationFrame(frameId);
    };
  }, [manifest, state.layers]);

  return (
    <div className="stage-shell" onClick={onClick} role="application" aria-label="AIR game stage">
      <canvas ref={canvasRef} className="game-canvas" />
      <div className="stage-vignette" />
    </div>
  );
}

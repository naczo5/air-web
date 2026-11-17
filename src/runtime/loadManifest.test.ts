import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameManifest } from "../types";
import { loadManifest } from "./loadManifest";

function jsonResponse(value: unknown, status = 200): unknown {
  const body = Buffer.from(JSON.stringify(value));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null },
    json: async () => JSON.parse(body.toString("utf8")),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

function gzipResponse(value: unknown, status = 200): unknown {
  const body = gzipSync(Buffer.from(JSON.stringify(value)));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/gzip" },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

const packedIndex = {
  id: "air-se",
  title: "AIR",
  logicalSize: { width: 640, height: 480 },
  startScene: "seen0001",
  scenes: {},
  sceneIndex: { seen0001: { u: "/scenes/seen0001-abcdef.json.gz", e: { "0": 2 } } },
  assets: {
    "image:G00_BG001.g00": { id: "image:G00_BG001.g00", kind: "image", url: "/pack/images_bg-000-abcdef.pack#0-10:png", codec: "png" },
    "audio:BGM_BGM00.nwa": { id: "audio:BGM_BGM00.nwa", kind: "audio", url: "/audio/BGM__BGM00.wav", codec: "wav" },
  },
  flowchart: { nodes: [], edges: [] },
  generatedAt: "2026-01-01T00:00:00.000Z",
} satisfies GameManifest & { sceneIndex: unknown };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadManifest packed mode", () => {
  it("loads the bootstrap and gzipped index, then rebases URLs", async () => {
    const bootstrap = { format: "air-pack-v1", version: 1, index: "manifest.index-abc.json.gz", fallback: "manifest.index-abc.json" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/manifest.json")) return jsonResponse(bootstrap);
      if (url.endsWith("manifest.index-abc.json.gz")) return gzipResponse(packedIndex);
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const manifest = await loadManifest();
    expect(fetchMock).toHaveBeenCalledWith("/manifest.json", { cache: "no-store" });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("manifest.index-abc.json.gz"), { cache: "force-cache" });
    expect(Object.keys(manifest.scenes)).toEqual(["seen0001"]);
    expect(manifest.scenes.seen0001).toBeTruthy();
    expect(manifest.assets["image:G00_BG001.g00"].url).toBe(`${window.location.origin}/pack/images_bg-000-abcdef.pack#0-10:png`);
    expect(manifest.assets["audio:BGM_BGM00.nwa"].url).toBe(`${window.location.origin}/audio/BGM__BGM00.wav`);
  });

  it("falls back to the raw index when gzip cannot be fetched", async () => {
    const bootstrap = { format: "air-pack-v1", version: 1, index: "manifest.index-abc.json.gz", fallback: "manifest.index-abc.json" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/manifest.json")) return jsonResponse(bootstrap);
      if (url.endsWith(".json.gz")) return jsonResponse({}, 404);
      if (url.endsWith("manifest.index-abc.json")) return jsonResponse(packedIndex);
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const manifest = await loadManifest();
    expect(Object.keys(manifest.scenes)).toEqual(["seen0001"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("still accepts a legacy uncompressed manifest", async () => {
    const legacy: GameManifest = {
      ...packedIndex,
      scenes: { seen0001: { id: "seen0001", instructions: [] } },
      sceneIndex: undefined,
    } as unknown as GameManifest;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(legacy)));
    const manifest = await loadManifest();
    expect(manifest.scenes.seen0001.instructions).toEqual([]);
  });
});

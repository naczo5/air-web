import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPackCaches,
  configurePackCache,
  isPackedRef,
  packCacheStatus,
  resolveAssetUrl,
  resolveAudioUrl,
} from "./packResolver";

type MockResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
};

function bytes(from: number, to: number): Uint8Array {
  return Uint8Array.from({ length: to - from }, (_, index) => from + index);
}

function copy(buffer: Uint8Array): ArrayBuffer {
  const result = new Uint8Array(buffer.byteLength);
  result.set(buffer);
  return result.buffer;
}

function response(body: Uint8Array, status = 200, headers: Record<string, string> = {}): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () => copy(body),
  };
}

const blobs = new Map<string, Blob>();
let blobCounter = 0;
let fetchMock: ReturnType<typeof vi.fn>;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

async function blobData(url: string): Promise<Uint8Array> {
  const blob = blobs.get(url);
  if (!blob) throw new Error(`No blob for ${url}`);
  return new Uint8Array(await blob.arrayBuffer());
}

beforeEach(() => {
  clearPackCaches();
  configurePackCache({ maxBytes: 1024 * 1024, maxEntries: 64, maxChunks: 4, maxChunkBytes: 1024 * 1024 });
  blobs.clear();
  blobCounter = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => {
      const url = `blob:test/${++blobCounter}`;
      blobs.set(url, blob);
      return url;
    }),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn((url: string) => { blobs.delete(url); }),
  });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  clearPackCaches();
  vi.unstubAllGlobals();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: originalCreate });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: originalRevoke });
});

describe("packResolver", () => {
  it("passes plain URLs through without a request", async () => {
    const url = "https://example.test/audio/BGM__BGM00.wav";
    await expect(resolveAssetUrl(url, "audio")).resolves.toBe(url);
    await expect(resolveAudioUrl(url)).resolves.toBe(url);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isPackedRef(url)).toBe(false);
  });

  it("recognizes packed references", () => {
    expect(isPackedRef("/pack/voices_0000-000-abcdef.pack#10-20:ogg")).toBe(true);
    expect(isPackedRef("https://cdn.test/pack/images_bg-000-abcdef.pack#0-5:png")).toBe(true);
    expect(isPackedRef("https://cdn.test/audio/file.wav")).toBe(false);
  });

  it("resolves a 206 range with exactly one request", async () => {
    const archive = bytes(0, 40);
    fetchMock.mockResolvedValueOnce(response(archive.slice(10, 20), 206, { "content-range": "bytes 10-19/40" }));
    const url = await resolveAssetUrl("/pack/voices_0000-000-abcdef.pack#10-20:ogg", "voice");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/pack/voices_0000-000-abcdef.pack", {
      headers: { Range: "bytes=10-19" },
      cache: "force-cache",
    });
    expect(Array.from(await blobData(url))).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(blobs.get(url)?.type).toBe("audio/ogg");
  });

  it("slices a 200 response when Range is ignored", async () => {
    const archive = bytes(0, 40);
    fetchMock.mockResolvedValueOnce(response(archive, 200));
    const url = await resolveAssetUrl("/pack/images_bg-000-abcdef.pack#5-12:png", "image");
    expect(Array.from(await blobData(url))).toEqual([5, 6, 7, 8, 9, 10, 11]);
    expect(blobs.get(url)?.type).toBe("image/png");
  });

  it("does not re-request a full chunk after a host ignores Range", async () => {
    const archive = bytes(0, 40);
    fetchMock.mockResolvedValue(response(archive, 200));
    const first = await resolveAssetUrl("/pack/voices_0000-000-abcdef.pack#0-4:ogg", "voice");
    expect(Array.from(await blobData(first))).toEqual([0, 1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await resolveAssetUrl("/pack/voices_0000-000-abcdef.pack#20-24:ogg", "voice");
    expect(Array.from(await blobData(second))).toEqual([20, 21, 22, 23]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a wrong-length 206 and falls back to the full chunk", async () => {
    fetchMock
      .mockResolvedValueOnce(response(bytes(0, 3), 206, { "content-range": "bytes 10-19/40" }))
      .mockResolvedValueOnce(response(bytes(0, 40), 200));
    const url = await resolveAssetUrl("/pack/voices_0000-000-abcdef.pack#10-20:ogg", "voice");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Array.from(await blobData(url))).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it("rejects when both the range and full chunk are unusable", async () => {
    fetchMock
      .mockResolvedValueOnce(response(bytes(0, 3), 206))
      .mockResolvedValueOnce(response(bytes(0, 5), 200));
    await expect(resolveAssetUrl("/pack/voices_0000-000-abcdef.pack#10-20:ogg", "voice")).rejects.toThrow(/Unable to read bytes/);
  });

  it("dedupes concurrent requests for the same ref", async () => {
    let release!: (value: MockResponse) => void;
    fetchMock.mockReturnValueOnce(new Promise<MockResponse>((resolve) => { release = resolve; }));
    const first = resolveAssetUrl("/pack/voices_0000-000-abcdef.pack#0-4:ogg", "voice");
    const second = resolveAssetUrl("/pack/voices_0000-000-abcdef.pack#0-4:ogg", "voice");
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(response(bytes(0, 4), 206, { "content-range": "bytes 0-3/40" }));
    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("evicts and revokes Blob URLs at the byte cap", async () => {
    configurePackCache({ maxBytes: 4, maxEntries: 10 });
    fetchMock.mockImplementation((_url, init) => {
      const range = new Headers(init?.headers as HeadersInit).get("Range") ?? "bytes=0-2";
      const match = /bytes=(\d+)-(\d+)/.exec(range)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      return Promise.resolve(response(bytes(start, end + 1), 206, { "content-range": `${range}/100` }));
    });
    const first = await resolveAssetUrl("/pack/a.pack#0-3:x", "binary");
    expect(packCacheStatus()).toMatchObject({ entries: 1, bytes: 3 });
    const second = await resolveAssetUrl("/pack/b.pack#0-3:x", "binary");
    expect(second).not.toBe(first);
    expect(packCacheStatus()).toMatchObject({ entries: 1, bytes: 3 });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
    expect(blobs.has(first)).toBe(false);
  });

  it("rejects an inverted range", async () => {
    await expect(resolveAssetUrl("/pack/a.pack#10-10:ogg", "voice")).rejects.toThrow(/Invalid packed asset range/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

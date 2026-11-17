/** Decompress a gzip body, or pass already-decoded JSON through. */
export async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress gzip data.");
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const body = new Response(copy.buffer).body;
  if (!body) throw new Error("Unable to read the compressed response body.");
  const stream = body.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

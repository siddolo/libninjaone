/* Bound decoded stream bytes as well as the advertised wire size. Fetch may
 * decompress a body whose Content-Length is smaller than its decoded size. */
export class ResponseTooLargeError extends Error {
  constructor(readonly limit: number, readonly status: number) {
    super(`Response exceeds the ${limit}-byte limit`);
    this.name = 'ResponseTooLargeError';
  }
}

export async function readResponse(response: Response, limit: number): Promise<ArrayBuffer> {
  const length = response.headers.get('Content-Length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(limit, response.status);
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  let bytes = new Uint8Array(0);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - size) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError(limit, response.status);
      }
      const required = size + value.byteLength;
      if (required > bytes.byteLength) {
        /* Geometric growth bounds allocations even for tiny stream chunks. */
        const capacity = Math.min(limit, Math.max(required, bytes.byteLength * 2, 4096));
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(value, size);
      size = required;
    }
  } finally {
    reader.releaseLock();
  }
  return size === bytes.byteLength ? bytes.buffer : bytes.buffer.slice(0, size);
}

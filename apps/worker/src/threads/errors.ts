/**
 * What crosses between a thread and the main thread besides plain data (FLR-T-14.12): an error, by
 * its kind and its words — a RangeError stays a RangeError, the refusal a job reports — and the
 * buffers a result can move rather than copy.
 */

export interface ThreadError {
  readonly name: string;
  readonly message: string;
}

export function describeError(error: unknown): ThreadError {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) };
}

/** An error from a thread, as the kind it was. */
export function revive(error: ThreadError): Error {
  const made = error.name === 'RangeError' ? new RangeError(error.message) : error.name === 'TypeError' ? new TypeError(error.message) : new Error(error.message);
  if (made.name !== error.name) made.name = error.name;
  return made;
}

/**
 * The buffers of `views` that can be moved: each whole buffer once, never a shared one, and never a
 * view onto part of a larger buffer (Buffer's pool, a slice) — moving that would take its neighbours.
 */
export function transferable(views: readonly (ArrayBufferView | undefined)[]): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const v of views) {
    if (v === undefined) continue;
    const buffer = v.buffer;
    if (!(buffer instanceof ArrayBuffer)) continue;
    if (v.byteOffset !== 0 || v.byteLength !== buffer.byteLength) continue;
    out.add(buffer);
  }
  return [...out];
}

/**
 * A shared ceiling on how many bytes of request body may be buffered for prompt
 * capture at any one moment, across all in-flight requests.
 *
 * Capture buffers the request prefix so the extractor can re-read it once the
 * body ends. That cost is per-request and concurrent: measured on this code, six
 * simultaneous 15 MiB requests move RSS by ~238 MB. A per-request limit alone
 * cannot bound that — only a shared one can.
 *
 * Exceeding the budget must never fail the request. A denied reservation drops
 * conversation capture for that one request (it records as `not_applicable`, the
 * same as any request with no extractable prompt) and leaves byte-for-byte
 * proxying untouched.
 */

/**
 * Buffering N bytes of request body costs appreciably more than N bytes of
 * process memory: the chunks are retained, `Buffer.concat` copies them into one
 * contiguous buffer, and the extractor decodes that into a UTF-16 string. All
 * three are live at once at the moment of extraction.
 *
 * Measured end to end against this proxy (RSS delta, 15 MiB bodies, 1/2/4
 * concurrent): 3.2x, 2.8x, 2.7x. The budget therefore reserves against
 * *estimated peak memory* rather than raw buffered bytes — accounting the raw
 * number is what let an earlier version of this budget admit ~220 MB while
 * believing it had capped at 64 MB.
 */
export const CAPTURE_MEMORY_AMPLIFICATION = 3;

/**
 * Default shared ceiling, expressed as estimated peak memory rather than body
 * bytes. 64 MiB admits roughly one maximum-size capture at a time and leaves
 * room on a small host.
 */
export const CAPTURE_BUDGET_DEFAULT_BYTES = 64 * 1024 * 1024;

export function createCaptureBudget({
  maxBytes = CAPTURE_BUDGET_DEFAULT_BYTES,
  amplification = CAPTURE_MEMORY_AMPLIFICATION,
} = {}) {
  const ceiling = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  const factor = Number.isFinite(amplification) && amplification > 0 ? amplification : 1;
  let inFlight = 0;

  function cost(bytes) {
    const amount = Number(bytes);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    return Math.ceil(amount * factor);
  }

  return {
    /**
     * Reserve room to buffer `bytes` more of a request body.
     * @returns {boolean} whether the shared ceiling allows it.
     */
    tryReserve(bytes) {
      const amount = cost(bytes);
      if (amount === 0) return true;
      if (inFlight + amount > ceiling) return false;
      inFlight += amount;
      return true;
    },

    /** Return the room reserved for `bytes`. Never drifts below zero. */
    release(bytes) {
      const amount = cost(bytes);
      if (amount === 0) return;
      inFlight = Math.max(0, inFlight - amount);
    },

    /** Estimated peak memory currently reserved, in bytes. */
    inFlightBytes() {
      return inFlight;
    },

    maxBytes() {
      return ceiling;
    },
  };
}

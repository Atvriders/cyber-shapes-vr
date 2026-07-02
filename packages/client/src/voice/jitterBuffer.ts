/**
 * jitterBuffer.ts — Deterministic per-peer jitter buffer (B10).
 *
 * Pure class: no Date/performance calls at module scope. All timing is
 * injected via the `nowMs` parameter passed to `pop()`.
 *
 * Algorithm:
 *   - Frames are stored in a min-heap keyed by tsMs (ordered by arrival
 *     timestamp). For simplicity we use a sorted array (frame counts are low,
 *     typically <10 at any time).
 *   - pop(nowMs): returns the oldest frame only when:
 *       nowMs - newestTsMs >= targetDepthMs   (buffered enough)
 *     This introduces ~targetDepthMs of playout delay before the first frame
 *     of a new stream is delivered.
 *   - Overflow: when the span (newest - oldest) > maxDepthMs, drop oldest
 *     frames until the span is within budget.
 *   - talk-stop (FLAG_TALK_STOP, bit2): after popping a talk-stop frame the
 *     buffer is immediately flushed so a new utterance starts clean.
 *
 * Voice frame flags (bit masks):
 *   bit0 = 0x01 → key / first Opus frame
 *   bit1 = 0x02 → talk-start (PTT press)
 *   bit2 = 0x04 → talk-stop  (PTT release)
 */

// ---------------------------------------------------------------------------
// Flag constants (exported so the orchestrator and tests can share them)
// ---------------------------------------------------------------------------

export const FLAG_KEY = 0x01;
export const FLAG_TALK_START = 0x02;
export const FLAG_TALK_STOP = 0x04;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JitterFrame {
  tsMs: number;
  bytes: Uint8Array;
  flags: number;
}

export interface JitterBufferOpts {
  /** Target buffering depth before first frame is released (ms). Default: 60 */
  targetDepthMs?: number;
  /** Maximum buffering depth; oldest frames dropped when exceeded (ms). Default: 200 */
  maxDepthMs?: number;
}

// ---------------------------------------------------------------------------
// JitterBuffer
// ---------------------------------------------------------------------------

export class JitterBuffer {
  private readonly _targetDepthMs: number;
  private readonly _maxDepthMs: number;

  /** Sorted list (ascending tsMs) of buffered frames. */
  private _frames: JitterFrame[] = [];

  /** Timestamp of the newest frame ever pushed (for depth calculation). */
  private _newestTsMs: number | null = null;

  constructor(opts: JitterBufferOpts = {}) {
    this._targetDepthMs = opts.targetDepthMs ?? 60;
    this._maxDepthMs = opts.maxDepthMs ?? 200;
  }

  // -------------------------------------------------------------------------
  // push
  // -------------------------------------------------------------------------

  /**
   * Insert a frame into the buffer, maintaining ascending tsMs order.
   * After insertion, drops oldest frames if the span exceeds maxDepthMs.
   */
  push(tsMs: number, bytes: Uint8Array, flags: number): void {
    // Track newest ts for readiness check
    if (this._newestTsMs === null || tsMs > this._newestTsMs) {
      this._newestTsMs = tsMs;
    }

    // Insert in sorted position (binary-search-ish for a short array)
    const frame: JitterFrame = { tsMs, bytes, flags };
    let lo = 0;
    let hi = this._frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._frames[mid].tsMs <= tsMs) lo = mid + 1;
      else hi = mid;
    }
    this._frames.splice(lo, 0, frame);

    // Enforce maxDepth: drop oldest until span <= maxDepthMs
    this._enforceMaxDepth();
  }

  // -------------------------------------------------------------------------
  // pop
  // -------------------------------------------------------------------------

  /**
   * Return the next in-order frame, or null if:
   *   - No frames buffered, OR
   *   - Not yet buffered past targetDepthMs (nowMs - newestTs < targetDepthMs)
   *
   * On returning a talk-stop frame (FLAG_TALK_STOP), flushes the buffer.
   */
  pop(nowMs: number): JitterFrame | null {
    if (this._frames.length === 0) return null;
    if (this._newestTsMs === null) return null;

    // Not yet ready — waiting for targetDepth of buffering
    if (nowMs - this._newestTsMs < this._targetDepthMs) return null;

    const frame = this._frames.shift()!;

    // After returning a talk-stop frame, flush remaining frames from this
    // utterance so the next utterance starts with a clean buffer.
    if (frame.flags & FLAG_TALK_STOP) {
      this._frames = [];
      this._newestTsMs = null;
    }

    return frame;
  }

  // -------------------------------------------------------------------------
  // flush
  // -------------------------------------------------------------------------

  /** Immediately discard all buffered frames. */
  flush(): void {
    this._frames = [];
    this._newestTsMs = null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _enforceMaxDepth(): void {
    while (this._frames.length >= 2) {
      const oldest = this._frames[0].tsMs;
      const newest = this._frames[this._frames.length - 1].tsMs;
      if (newest - oldest <= this._maxDepthMs) break;
      this._frames.shift();
    }
  }
}

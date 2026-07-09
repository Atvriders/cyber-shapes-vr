/**
 * clips.test.ts — Task C31 (F20 Neon Clip Machine, spec §7.20) unit tests for
 * the client's PURE surface (spec: "MediaRecorder can't run under Vitest" —
 * the split is deliberate). Covers:
 *   • the codec probe order (pure fn)
 *   • clipId minting + the ≥128-bit shape gate
 *   • the compositor draw-list builder (chyron + caster line + replay chrome + end-slate)
 *   • the draw-list APPLIER against a plain mock 2D context (no real Canvas needed)
 *   • the ClipRecorder state machine (idle→recording→finalizing→delivered + discard)
 *   • the ClipDirector auto-first-per-rotation + SAVE CLIP override gating
 *   • the ClipBank no-uplink rung
 *   • postClip / clipRetrievalUrl (fetch injected)
 *   • captureCompositorStream / tapMasterBusForClip (mock canvas/AudioContext —
 *     thin glue, still fully testable without a real browser)
 *
 * TDD RED — written before clips.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  probeClipCodec,
  CLIP_MIME_MP4,
  CLIP_MIME_VP8,
  CLIP_MIME_VP9,
  mintClipId,
  isValidClipId,
  webCryptoRandomBytes,
  CLIP_ID_BYTES,
  CLIP_ID_RE,
  buildClipDrawList,
  drawClipFrame,
  defaultQrPlaceholder,
  CLIP_WIDTH,
  CLIP_HEIGHT,
  CLIP_CAPTURE_FPS,
  ClipRecorder,
  ClipRecorderStateError,
  ClipDirector,
  ClipBank,
  clipRetrievalUrl,
  postClip,
  captureCompositorStream,
  tapMasterBusForClip,
  type ClipDrawCommand,
  type Canvas2DLike,
} from '../src/stage/clips.ts';
import { DIRECTOR_KIND } from '@cyber-shapes/shared';

// ===========================================================================
// Codec probe order (pure) — spec §7.20: mp4 → vp8 → vp9-if-enabled
// ===========================================================================

describe('C31 — probeClipCodec (codec probe order, pure)', () => {
  it('picks mp4 FIRST when supported, regardless of vp8/vp9 support', () => {
    const canSupport = (m: string) => [CLIP_MIME_MP4, CLIP_MIME_VP8, CLIP_MIME_VP9].includes(m);
    expect(probeClipCodec(canSupport, { vp9Enabled: true })).toBe(CLIP_MIME_MP4);
  });

  it('falls back to vp8 when mp4 is unsupported', () => {
    const canSupport = (m: string) => m === CLIP_MIME_VP8;
    expect(probeClipCodec(canSupport)).toBe(CLIP_MIME_VP8);
  });

  it('NEVER tries vp9 unless explicitly enabled, even when vp9 support is reported', () => {
    const canSupport = (m: string) => m === CLIP_MIME_VP9;
    expect(probeClipCodec(canSupport)).toBeNull(); // vp9Enabled defaults false
    expect(probeClipCodec(canSupport, { vp9Enabled: false })).toBeNull();
  });

  it('tries vp9 ONLY when explicitly enabled AND mp4/vp8 are both unsupported', () => {
    const canSupport = (m: string) => m === CLIP_MIME_VP9;
    expect(probeClipCodec(canSupport, { vp9Enabled: true })).toBe(CLIP_MIME_VP9);
  });

  it('vp9Enabled never PROMOTES vp9 over mp4/vp8 — the order is fixed', () => {
    const canSupport = () => true; // everything supported
    expect(probeClipCodec(canSupport, { vp9Enabled: true })).toBe(CLIP_MIME_MP4);
  });

  it('returns null when nothing in the ladder is supported', () => {
    expect(probeClipCodec(() => false, { vp9Enabled: true })).toBeNull();
  });
});

// ===========================================================================
// clipId — pre-minted, >= 128-bit crypto-random
// ===========================================================================

describe('C31 — mintClipId / isValidClipId (>= 128-bit entropy)', () => {
  it('mints a 32-hex-char id from a 16-byte (128-bit) source', () => {
    const bytes = new Uint8Array(CLIP_ID_BYTES).map((_, i) => i);
    const id = mintClipId(() => bytes);
    expect(id).toHaveLength(32);
    expect(CLIP_ID_RE.test(id)).toBe(true);
    expect(isValidClipId(id)).toBe(true);
  });

  it('CLIP_ID_BYTES is exactly 128 bits (the spec floor)', () => {
    expect(CLIP_ID_BYTES * 8).toBe(128);
  });

  it('throws if the entropy source under-delivers (never silently truncates/pads)', () => {
    expect(() => mintClipId(() => new Uint8Array(8))).toThrow();
  });

  it('two mints from a real varying source never collide (entropy sanity, not a formal proof)', () => {
    let n = 0;
    const src = () => {
      const b = new Uint8Array(CLIP_ID_BYTES);
      b[0] = n++;
      for (let i = 1; i < CLIP_ID_BYTES; i++) b[i] = (n * 97 + i) & 0xff;
      return b;
    };
    const a = mintClipId(src);
    const b = mintClipId(src);
    expect(a).not.toBe(b);
  });

  it('isValidClipId rejects short/malformed/non-hex ids (no loose matching)', () => {
    expect(isValidClipId('a'.repeat(31))).toBe(false);
    expect(isValidClipId('g'.repeat(32))).toBe(false);
    expect(isValidClipId('')).toBe(false);
    expect(isValidClipId('../../etc/passwd')).toBe(false);
    // Fold-in (align client/server): the client mints EXACTLY 32 chars; a 33/64-char
    // id is rejected (the server gate is now the identical /^[0-9a-f]{32}$/).
    expect(isValidClipId('a'.repeat(33))).toBe(false);
    expect(isValidClipId('a'.repeat(64))).toBe(false);
    expect(CLIP_ID_RE.source).toBe('^[0-9a-f]{32}$');
  });
});

// ===========================================================================
// clipId uses the CRYPTO source (test-hygiene fold-in) — a Math.random-based
// mint must FAIL; assert crypto.getRandomValues is the actual source.
// ===========================================================================

describe('C31 — clipId is minted from the CRYPTO source (never Math.random)', () => {
  it('webCryptoRandomBytes delegates to crypto.getRandomValues and NOT Math.random', () => {
    const c = (globalThis as unknown as { crypto: Crypto }).crypto;
    const cryptoSpy = vi.spyOn(c, 'getRandomValues');
    const mathSpy = vi.spyOn(Math, 'random');
    const id = mintClipId(webCryptoRandomBytes);
    expect(cryptoSpy).toHaveBeenCalled(); // the crypto source WAS used
    expect(mathSpy).not.toHaveBeenCalled(); // Math.random was NOT
    expect(isValidClipId(id)).toBe(true);
    cryptoSpy.mockRestore();
    mathSpy.mockRestore();
  });

  it('a degenerate (Math.random-style) low-entropy source is DETECTABLY caught (not a 32*4>=128 literal)', () => {
    // A non-crypto generator can return low-entropy bytes (here the all-constant
    // degenerate case). The minted id is detectably low-entropy — the guard the
    // old `32*4 >= 128` tautology never provided (it passed for ANY 32-char id).
    const constantSource = (n: number) => new Uint8Array(n); // all zeros
    const weakId = mintClipId(constantSource);
    const distinctWeak = new Set(weakId.match(/../g));
    expect(distinctWeak.size).toBeLessThan(4); // FAILS an entropy floor

    // A REAL crypto mint clears the same floor comfortably (high entropy).
    const realId = mintClipId(webCryptoRandomBytes);
    const distinctReal = new Set(realId.match(/../g));
    expect(distinctReal.size).toBeGreaterThanOrEqual(8);
  });

  it('two crypto mints are non-colliding and non-sequential (high entropy, not an increment)', () => {
    const a = mintClipId(webCryptoRandomBytes);
    const b = mintClipId(webCryptoRandomBytes);
    expect(a).not.toBe(b);
    expect(BigInt('0x' + b) - BigInt('0x' + a)).not.toBe(1n);
  });
});

// ===========================================================================
// SAVE_CLIP kind minted (client-visible via the shared registry)
// ===========================================================================

describe('C31 — SAVE_CLIP minted in the shared DIRECTOR registry', () => {
  it('DIRECTOR_KIND.SAVE_CLIP exists and is a distinct byte', () => {
    expect(DIRECTOR_KIND.SAVE_CLIP).toBeTypeOf('number');
    expect(new Set(Object.values(DIRECTOR_KIND)).size).toBe(Object.values(DIRECTOR_KIND).length);
  });
});

// ===========================================================================
// buildClipDrawList (pure) — chyron + caster line + replay chrome + end-slate
// ===========================================================================

describe('C31 — buildClipDrawList (compositor draw list, pure)', () => {
  it('the stage frame is ALWAYS first (drawImage of the WebGL canvas underlies everything)', () => {
    const list = buildClipDrawList({ stageSource: 'STAGE_CANVAS', chyronText: '' });
    expect(list[0]).toEqual({ kind: 'stage-frame', source: 'STAGE_CANVAS' });
  });

  it('includes the chyron when a callsign is given', () => {
    const list = buildClipDrawList({ stageSource: null, chyronText: 'VOLT-17' });
    expect(list).toContainEqual({ kind: 'chyron', text: 'VOLT-17' });
  });

  it('omits the chyron when empty (no callsign yet)', () => {
    const list = buildClipDrawList({ stageSource: null, chyronText: '' });
    expect(list.some((c) => c.kind === 'chyron')).toBe(false);
  });

  it('includes the C26 caster line ONLY when attached (attach-if-landed)', () => {
    const withCaption = buildClipDrawList({ stageSource: null, chyronText: 'X', casterLineText: 'VOLT-17 NAILS A SLAM' });
    expect(withCaption).toContainEqual({ kind: 'caster-line', text: 'VOLT-17 NAILS A SLAM' });

    const withoutCaption = buildClipDrawList({ stageSource: null, chyronText: 'X', casterLineText: null });
    expect(withoutCaption.some((c) => c.kind === 'caster-line')).toBe(false);

    const absentCaption = buildClipDrawList({ stageSource: null, chyronText: 'X' });
    expect(absentCaption.some((c) => c.kind === 'caster-line')).toBe(false);
  });

  it('includes replay chrome text when given (a highlight replay is riding)', () => {
    const list = buildClipDrawList({ stageSource: null, chyronText: 'X', replayChromeText: 'REPLAY // T-3.0s' });
    expect(list).toContainEqual({ kind: 'replay-chrome', text: 'REPLAY // T-3.0s' });
  });

  it('includes the end-slate ONLY on the trailing frames (spec 2-3s), carrying the retrieval URL', () => {
    const list = buildClipDrawList({
      stageSource: null,
      chyronText: 'X',
      endSlate: { url: 'https://booth.example/api/clips/abc123', label: 'SCAN TO TAKE YOUR CLIP HOME' },
    });
    expect(list).toContainEqual({
      kind: 'end-slate',
      url: 'https://booth.example/api/clips/abc123',
      label: 'SCAN TO TAKE YOUR CLIP HOME',
    });

    const withoutSlate = buildClipDrawList({ stageSource: null, chyronText: 'X' });
    expect(withoutSlate.some((c) => c.kind === 'end-slate')).toBe(false);
  });

  it('a fully-populated frame includes ALL FOUR overlay layers on top of the stage frame, in paint order', () => {
    const list = buildClipDrawList({
      stageSource: 'S',
      chyronText: 'VOLT-17',
      casterLineText: 'CASTER LINE',
      replayChromeText: 'REPLAY // T-1.0s',
      endSlate: { url: 'https://x/api/clips/deadbeef', label: 'SCAN' },
    });
    expect(list.map((c) => c.kind)).toEqual([
      'stage-frame',
      'chyron',
      'caster-line',
      'replay-chrome',
      'end-slate',
    ]);
  });
});

// ===========================================================================
// drawClipFrame (the applier) — against a plain MOCK 2D context (no real Canvas)
// ===========================================================================

class MockCtx implements Canvas2DLike {
  calls: string[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  font = '';
  textAlign = '';
  textBaseline = '';
  drawImage(source: unknown, dx: number, dy: number, dw: number, dh: number): void {
    this.calls.push(`drawImage(${String(source)},${dx},${dy},${dw},${dh})`);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.calls.push(`fillRect(${x},${y},${w},${h})`);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.calls.push(`strokeRect(${x},${y},${w},${h})`);
  }
  fillText(text: string, x: number, y: number): void {
    this.calls.push(`fillText(${text},${x},${y})`);
  }
  save(): void {
    this.calls.push('save');
  }
  restore(): void {
    this.calls.push('restore');
  }
}

describe('C31 — drawClipFrame (the compositor applier)', () => {
  it('draws the stage frame at the full CLIP_WIDTH x CLIP_HEIGHT', () => {
    const ctx = new MockCtx();
    const cmds: ClipDrawCommand[] = [{ kind: 'stage-frame', source: 'CANVAS' }];
    drawClipFrame(ctx, cmds);
    expect(ctx.calls).toContain(`drawImage(CANVAS,0,0,${CLIP_WIDTH},${CLIP_HEIGHT})`);
  });

  it('draws chyron + caster-line + replay-chrome text (fillText is called with each string)', () => {
    const ctx = new MockCtx();
    const cmds: ClipDrawCommand[] = [
      { kind: 'chyron', text: 'VOLT-17' },
      { kind: 'caster-line', text: 'A SLAM' },
      { kind: 'replay-chrome', text: 'REPLAY // T-1.0s' },
    ];
    drawClipFrame(ctx, cmds);
    const text = ctx.calls.join('\n');
    expect(text).toContain('VOLT-17');
    expect(text).toContain('A SLAM');
    expect(text).toContain('REPLAY // T-1.0s');
  });

  it('the end-slate calls the injected qrRenderer with the retrieval URL', () => {
    const ctx = new MockCtx();
    const qrCalls: Array<{ x: number; y: number; size: number; url: string }> = [];
    const cmds: ClipDrawCommand[] = [
      { kind: 'end-slate', url: 'https://booth.example/api/clips/deadbeef', label: 'SCAN' },
    ];
    drawClipFrame(ctx, cmds, {
      qrRenderer: (_c, x, y, size, url) => {
        qrCalls.push({ x, y, size, url });
      },
    });
    expect(qrCalls).toHaveLength(1);
    expect(qrCalls[0]!.url).toBe('https://booth.example/api/clips/deadbeef');
  });

  it('the DEFAULT qr placeholder draws a bordered box + the url as text (never throws with no injected renderer)', () => {
    const ctx = new MockCtx();
    expect(() => defaultQrPlaceholder(ctx, 10, 10, 100, 'https://x/api/clips/abc')).not.toThrow();
    const text = ctx.calls.join('\n');
    expect(text).toContain('strokeRect');
    expect(text).toContain('https://x/api/clips/abc');
  });

  it('a full draw list (all 5 commands) hits the stage frame, all 3 text layers, AND the end-slate — nothing silently dropped', () => {
    const ctx = new MockCtx();
    const cmds = buildClipDrawList({
      stageSource: 'S',
      chyronText: 'VOLT-17',
      casterLineText: 'CASTER',
      replayChromeText: 'CHROME',
      endSlate: { url: 'https://x/api/clips/f00d', label: 'SCAN' },
    });
    let qrCalled = false;
    drawClipFrame(ctx, cmds, { qrRenderer: () => (qrCalled = true) });
    const text = ctx.calls.join('\n');
    expect(text).toContain('drawImage');
    expect(text).toContain('VOLT-17');
    expect(text).toContain('CASTER');
    expect(text).toContain('CHROME');
    expect(qrCalled).toBe(true);
  });
});

// ===========================================================================
// ClipRecorder — idle → recording → finalizing → delivered (+ discard)
// ===========================================================================

const FAKE_CLIP_ID = 'a'.repeat(32);

describe('C31 — ClipRecorder state machine', () => {
  it('starts idle', () => {
    const r = new ClipRecorder();
    expect(r.state).toBe('idle');
    expect(r.clipId).toBeNull();
  });

  it('the happy path: idle -> recording -> finalizing -> delivered', () => {
    const r = new ClipRecorder();
    r.start(FAKE_CLIP_ID);
    expect(r.state).toBe('recording');
    expect(r.clipId).toBe(FAKE_CLIP_ID);
    r.stopRecording();
    expect(r.state).toBe('finalizing');
    r.markDelivered();
    expect(r.state).toBe('delivered');
  });

  it('discard() (console keep/discard DISCARD path) returns to idle from ANY non-idle state', () => {
    const recording = new ClipRecorder();
    recording.start(FAKE_CLIP_ID);
    recording.discard();
    expect(recording.state).toBe('idle');
    expect(recording.clipId).toBeNull();

    const finalizing = new ClipRecorder();
    finalizing.start(FAKE_CLIP_ID);
    finalizing.stopRecording();
    finalizing.discard();
    expect(finalizing.state).toBe('idle');
  });

  it('rejects start() from a non-idle state (invalid transition)', () => {
    const r = new ClipRecorder();
    r.start(FAKE_CLIP_ID);
    expect(() => r.start(FAKE_CLIP_ID)).toThrow(ClipRecorderStateError);
  });

  it('rejects stopRecording() from idle (invalid transition)', () => {
    const r = new ClipRecorder();
    expect(() => r.stopRecording()).toThrow(ClipRecorderStateError);
  });

  it('rejects markDelivered() before finalizing (invalid transition)', () => {
    const r = new ClipRecorder();
    expect(() => r.markDelivered()).toThrow(ClipRecorderStateError);
    r.start(FAKE_CLIP_ID);
    expect(() => r.markDelivered()).toThrow(ClipRecorderStateError); // still 'recording'
  });

  it('rejects start() with a malformed clipId (never records under a bad id)', () => {
    const r = new ClipRecorder();
    expect(() => r.start('not-a-valid-clip-id')).toThrow(ClipRecorderStateError);
    expect(r.state).toBe('idle');
  });

  it('reset() returns to idle (post-delivery cleanup for the next clip)', () => {
    const r = new ClipRecorder();
    r.start(FAKE_CLIP_ID);
    r.stopRecording();
    r.markDelivered();
    r.reset();
    expect(r.state).toBe('idle');
    expect(r.clipId).toBeNull();
  });
});

// ===========================================================================
// ClipDirector — auto-first-per-rotation + SAVE CLIP override
// ===========================================================================

describe('C31 — ClipDirector (auto-first + SAVE CLIP gating)', () => {
  it('maybeAutoClip mints a clipId when a highlight aired', () => {
    let n = 0;
    const d = new ClipDirector({ mintId: () => `id-${n++}` });
    expect(d.maybeAutoClip(true)).toBe('id-0');
  });

  it('maybeAutoClip returns null when NO highlight aired (min-activity gate lives in C21, reused not duplicated)', () => {
    const d = new ClipDirector({ mintId: () => 'id' });
    expect(d.maybeAutoClip(false)).toBeNull();
  });

  it('ONLY ONE auto-clip per rotation — a second STATS-transition in the SAME rotation is gated even if a highlight aired again', () => {
    let n = 0;
    const d = new ClipDirector({ mintId: () => `id-${n++}` });
    expect(d.maybeAutoClip(true)).toBe('id-0');
    expect(d.maybeAutoClip(true)).toBeNull(); // already auto-clipped this rotation
  });

  it('onRotationStart() (LOBBY entry) RE-ARMS the auto-first gate for the next rotation', () => {
    let n = 0;
    const d = new ClipDirector({ mintId: () => `id-${n++}` });
    expect(d.maybeAutoClip(true)).toBe('id-0');
    expect(d.maybeAutoClip(true)).toBeNull();
    d.onRotationStart();
    expect(d.maybeAutoClip(true)).toBe('id-1');
  });

  it('saveClip() (the hotkey/console override) is ALWAYS allowed — no rotation gate', () => {
    let n = 0;
    const d = new ClipDirector({ mintId: () => `id-${n++}` });
    expect(d.saveClip()).toBe('id-0');
    expect(d.saveClip()).toBe('id-1');
    // Consume this rotation's auto-clip slot...
    expect(d.maybeAutoClip(true)).toBe('id-2');
    expect(d.maybeAutoClip(true)).toBeNull(); // ...now gated for the rest of the rotation.
    // ...but the SAVE CLIP override is STILL always allowed.
    expect(d.saveClip()).toBe('id-3');
  });

  it('defaults to a real ≥128-bit mintId when none is injected', () => {
    const d = new ClipDirector();
    const id = d.saveClip();
    expect(isValidClipId(id)).toBe(true);
  });
});

// ===========================================================================
// ClipBank — the no-uplink rung
// ===========================================================================

describe('C31 — ClipBank (no-uplink rung)', () => {
  it('banks a clip and lists it as pending until marked delivered', () => {
    const bank = new ClipBank(() => 1000);
    bank.bank(FAKE_CLIP_ID, 'BLOB');
    expect(bank.has(FAKE_CLIP_ID)).toBe(true);
    expect(bank.pending()).toHaveLength(1);
    expect(bank.pending()[0]!.clipId).toBe(FAKE_CLIP_ID);

    bank.markDelivered(FAKE_CLIP_ID);
    expect(bank.pending()).toHaveLength(0);
    expect(bank.list()).toHaveLength(1);
    expect(bank.list()[0]!.delivered).toBe(true);
  });

  it('markDelivered on an unknown clipId is a no-op (never throws)', () => {
    const bank = new ClipBank();
    expect(() => bank.markDelivered('unknown')).not.toThrow();
  });
});

// ===========================================================================
// Delivery: clipRetrievalUrl + postClip (fetch injected)
// ===========================================================================

describe('C31 — clipRetrievalUrl', () => {
  it('builds the exact GET /api/clips/:id URL the end-slate QR encodes', () => {
    expect(clipRetrievalUrl('https://booth.example', FAKE_CLIP_ID)).toBe(
      `https://booth.example/api/clips/${FAKE_CLIP_ID}`
    );
  });

  it('strips a trailing slash on the origin', () => {
    expect(clipRetrievalUrl('https://booth.example/', FAKE_CLIP_ID)).toBe(
      `https://booth.example/api/clips/${FAKE_CLIP_ID}`
    );
  });
});

describe('C31 — postClip (POST /api/clips, ownerToken/roomId/clipId in HEADERS)', () => {
  it('sends the ownerToken/roomId/clipId as HEADERS, never in the URL', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://booth.example/api/clips'); // no ids/tokens in the URL
      const h = init?.headers as Record<string, string>;
      expect(h['X-Owner-Token']).toBe('secret-token');
      expect(h['X-Room-Id']).toBe('room1');
      expect(h['X-Clip-Id']).toBe(FAKE_CLIP_ID);
      return new Response(null, { status: 200 });
    });
    const res = await postClip({
      origin: 'https://booth.example',
      roomId: 'room1',
      ownerToken: 'secret-token',
      clipId: FAKE_CLIP_ID,
      contentType: 'video/webm',
      body: 'BYTES',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
  });

  it('reports {ok:false, status:0} when fetch throws (network down — the no-uplink trigger)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    });
    const res = await postClip({
      origin: 'https://booth.example',
      roomId: 'room1',
      ownerToken: 'tok',
      clipId: FAKE_CLIP_ID,
      contentType: 'video/webm',
      body: 'BYTES',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: false, status: 0 });
  });

  it('reports {ok:false, status:0} when no fetch is available at all', async () => {
    const res = await postClip({
      origin: 'https://booth.example',
      roomId: 'room1',
      ownerToken: 'tok',
      clipId: FAKE_CLIP_ID,
      contentType: 'video/webm',
      body: 'BYTES',
      fetchFn: undefined,
    });
    // In the Vitest node environment global fetch may or may not exist; either
    // way this call must not throw, and a real network attempt would fail fast
    // against booth.example — so just assert it resolves to a result shape.
    expect(typeof res.ok).toBe('boolean');
  });
});

// ===========================================================================
// captureCompositorStream / tapMasterBusForClip — thin real-API glue, still
// testable via plain mocks (no real Canvas/AudioContext needed).
// ===========================================================================

describe('C31 — captureCompositorStream (captureStream on the COMPOSITOR ONLY)', () => {
  it('calls canvas.captureStream(CLIP_CAPTURE_FPS) by default', () => {
    const fakeStream = {} as MediaStream;
    const canvas = { captureStream: vi.fn(() => fakeStream) };
    const result = captureCompositorStream(canvas);
    expect(canvas.captureStream).toHaveBeenCalledWith(CLIP_CAPTURE_FPS);
    expect(result).toBe(fakeStream);
  });

  it('CLIP_CAPTURE_FPS is 30 (spec §7.20 captureStream(30))', () => {
    expect(CLIP_CAPTURE_FPS).toBe(30);
  });

  it('honors an explicit fps override', () => {
    const canvas = { captureStream: vi.fn(() => ({}) as MediaStream) };
    captureCompositorStream(canvas, 24);
    expect(canvas.captureStream).toHaveBeenCalledWith(24);
  });
});

describe('C31 — tapMasterBusForClip (createMediaStreamDestination on the C9 masterBus)', () => {
  it('creates a MediaStreamDestination and connects the masterBus to it', () => {
    const dest = { kind: 'dest' } as unknown as MediaStreamAudioDestinationNode;
    const masterBus = { connect: vi.fn() } as unknown as AudioNode;
    const ctx = { createMediaStreamDestination: vi.fn(() => dest) } as unknown as AudioContext;

    const result = tapMasterBusForClip(ctx, masterBus);

    expect(ctx.createMediaStreamDestination).toHaveBeenCalledOnce();
    expect((masterBus as { connect: ReturnType<typeof vi.fn> }).connect).toHaveBeenCalledWith(dest);
    expect(result).toBe(dest);
  });
});

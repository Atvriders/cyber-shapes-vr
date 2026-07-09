/**
 * stage/clips.ts — F20 Neon Clip Machine: compositor + recorder state machine
 * (C31, spec §7.20).
 *
 * Everything below is DELIBERATELY split into a PURE, fully Vitest-testable
 * surface and a thin real-browser-API glue layer, mirroring the C21 replay
 * split (spec §7.20 "MediaRecorder can't run under Vitest"):
 *
 *   PURE (tested here):
 *     • probeClipCodec        — the codec ladder decision (mp4 → vp8 → vp9-if-enabled)
 *     • mintClipId/isValidClipId — ≥128-bit crypto-random clipId + its shape gate
 *     • buildClipDrawList     — the compositor's per-frame draw-command list
 *     • ClipRecorder          — the idle→recording→finalizing→delivered FSM
 *     • ClipDirector          — auto-first-per-rotation + SAVE CLIP override gating
 *     • ClipBank              — the no-uplink local bank
 *     • postClip/clipRetrievalUrl — the upload + QR-URL builders (fetch injected)
 *
 *   THIN GLUE (real Web APIs; owner/manual-verified — no MediaRecorder/
 *   captureStream/real Canvas2D under Vitest, spec §7.20 testability split):
 *     • drawClipFrame          — applies a draw list to a real/mock 2D context
 *     • captureCompositorStream — canvas.captureStream(30) — the COMPOSITOR ONLY;
 *       DOM overlays (lower-thirds, docked QR, banner) are NEVER captured — they
 *       render over the canvas via CSS and `captureStream` cannot see them
 *       (overlays.ts's own docstring: "DOM overlays are captured by neither
 *       WebXR nor captureStream, so C31 composites its own").
 *     • tapMasterBusForClip     — createMediaStreamDestination on the C9 mixer's
 *       masterBus (confirmed one-line tap, §7.20) — voice is structurally absent
 *       because the mixer never contains it (§6.2, mixer.ts).
 *
 * The end-slate QR RASTER itself follows the SAME "drawn by the caller" seam
 * `overlays.ts setQr()` already uses (and the RUNBOOK already treats QR
 * generation as a booth-ops step, never a bundled dependency) — `drawClipFrame`
 * takes an injectable `qrRenderer` hook; the default is a legible bordered
 * placeholder carrying the URL as text so a booth can wire a real QR renderer
 * without adding a runtime dependency to the tracked bundle.
 */

// ---------------------------------------------------------------------------
// Codec probe order (pure) — spec §7.20: mp4 (Chrome 126+ HW) → vp8 → vp9-if-enabled.
// ---------------------------------------------------------------------------

export const CLIP_MIME_MP4 = 'video/mp4';
export const CLIP_MIME_VP8 = 'video/webm;codecs=vp8,opus';
export const CLIP_MIME_VP9 = 'video/webm;codecs=vp9,opus';

export interface CodecProbeOpts {
  /**
   * vp9 is tried ONLY when explicitly enabled (spec §7.20 "vp9 only if
   * explicitly enabled after headroom is proven"). Default false.
   */
  vp9Enabled?: boolean;
}

/**
 * The codec ladder decision, pure: `canSupport` models
 * `MediaRecorder.isTypeSupported`. Returns the first supported mime type in
 * the mandated order, or null if nothing in the ladder is supported.
 */
export function probeClipCodec(
  canSupport: (mimeType: string) => boolean,
  opts: CodecProbeOpts = {}
): string | null {
  if (canSupport(CLIP_MIME_MP4)) return CLIP_MIME_MP4;
  if (canSupport(CLIP_MIME_VP8)) return CLIP_MIME_VP8;
  if (opts.vp9Enabled && canSupport(CLIP_MIME_VP9)) return CLIP_MIME_VP9;
  return null;
}

// ---------------------------------------------------------------------------
// clipId — pre-minted, ≥128-bit crypto-random (spec §7.20 "unlisted must mean
// unguessable"). Mirrors the server's CLIP_ID_RE exactly.
// ---------------------------------------------------------------------------

/** 16 bytes = 128 bits — the spec floor ("≥ 128-bit random"). */
export const CLIP_ID_BYTES = 16;

/** Must mirror `packages/server/src/clips.ts` CLIP_ID_RE exactly. */
export const CLIP_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Mint a clipId from an injected entropy source (≥ CLIP_ID_BYTES). Pure given
 * the source — tests inject a deterministic/fake generator; the real runtime
 * uses {@link webCryptoRandomBytes}.
 */
export function mintClipId(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(CLIP_ID_BYTES);
  if (bytes.length < CLIP_ID_BYTES) {
    throw new Error('mintClipId: insufficient entropy source (need >=128 bits)');
  }
  let hex = '';
  for (let i = 0; i < CLIP_ID_BYTES; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/** True iff `id` has the exact ≥128-bit hex shape (never a truncated/loose match). */
export function isValidClipId(id: string): boolean {
  return typeof id === 'string' && CLIP_ID_RE.test(id);
}

/** The real browser entropy source (Web Crypto). Tests inject a fake instead. */
export function webCryptoRandomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('webCryptoRandomBytes: no secure random source available');
  }
  c.getRandomValues(arr);
  return arr;
}

// ---------------------------------------------------------------------------
// Compositor draw list (pure) — 1280×720; the ONLY surface `captureStream`
// reads. Order = paint order (later commands draw on top).
// ---------------------------------------------------------------------------

export const CLIP_WIDTH = 1280;
export const CLIP_HEIGHT = 720;

/** The compositor's fixed capture rate (spec §7.20 `captureStream(30)`). */
export const CLIP_CAPTURE_FPS = 30;

/** The end-slate's on-screen duration (spec §7.20 "2–3 s"). */
export const CLIP_END_SLATE_MS = 2500;

/** The target overall clip length (spec §7.20 "fifteen seconds of THEIR catch"). */
export const CLIP_TARGET_DURATION_MS = 15_000;

export interface ClipFrameInput {
  /** The live stage WebGL canvas (or any drawImage-able source) — always drawn first. */
  stageSource: unknown;
  /** The callsign chyron — always present while recording (the catch's attribution). */
  chyronText: string;
  /** C26 caster line text — attach-if-landed; omit/null when absent, muted, or panicked. */
  casterLineText?: string | null;
  /** Replay chrome text (e.g. the C21 "REPLAY // T-…s" line) — omit for a live-ride recording. */
  replayChromeText?: string | null;
  /** Present ONLY on the trailing CLIP_END_SLATE_MS: the retrieval URL + label. */
  endSlate?: { url: string; label: string } | null;
}

export type ClipDrawCommand =
  | { kind: 'stage-frame'; source: unknown }
  | { kind: 'chyron'; text: string }
  | { kind: 'caster-line'; text: string }
  | { kind: 'replay-chrome'; text: string }
  | { kind: 'end-slate'; url: string; label: string };

/**
 * Build ONE frame's draw list from the current inputs. Pure — no canvas, no
 * DOM. The compositor's applier ({@link drawClipFrame}) walks this list.
 */
export function buildClipDrawList(input: ClipFrameInput): ClipDrawCommand[] {
  const cmds: ClipDrawCommand[] = [{ kind: 'stage-frame', source: input.stageSource }];
  if (input.chyronText) cmds.push({ kind: 'chyron', text: input.chyronText });
  if (input.casterLineText) cmds.push({ kind: 'caster-line', text: input.casterLineText });
  if (input.replayChromeText) cmds.push({ kind: 'replay-chrome', text: input.replayChromeText });
  if (input.endSlate) {
    cmds.push({ kind: 'end-slate', url: input.endSlate.url, label: input.endSlate.label });
  }
  return cmds;
}

// ---------------------------------------------------------------------------
// The 2D-context applier (thin; a plain mock context exercises it under
// Vitest — no real Canvas2D/jsdom canvas backend needed).
// ---------------------------------------------------------------------------

/** The minimal 2D-context surface the applier needs (a real CanvasRenderingContext2D satisfies it). */
export interface Canvas2DLike {
  drawImage(source: unknown, dx: number, dy: number, dw: number, dh: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  save(): void;
  restore(): void;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
}

export type QrRenderer = (ctx: Canvas2DLike, x: number, y: number, size: number, url: string) => void;

/**
 * The default end-slate QR placeholder: a bordered box + the URL as legible
 * text. Follows the SAME "the actual QR raster is drawn by the caller"
 * delegation `overlays.ts.setQr()` already uses (and the RUNBOOK already treats
 * QR generation as a booth-ops step) — a booth deploy injects a real QR
 * renderer here without adding a runtime dependency to the tracked bundle.
 */
export function defaultQrPlaceholder(ctx: Canvas2DLike, x: number, y: number, size: number, url: string): void {
  ctx.save();
  ctx.fillStyle = '#000000';
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = '#39ff14';
  ctx.lineWidth = 4;
  ctx.strokeRect(x, y, size, size);
  ctx.fillStyle = '#39ff14';
  ctx.font = '20px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(url, x + size / 2, y + size / 2, size - 16);
  ctx.restore();
}

export interface DrawClipFrameOpts {
  qrRenderer?: QrRenderer;
}

/** Apply one draw list to a 2D context. Real-canvas glue — thin by design. */
export function drawClipFrame(ctx: Canvas2DLike, commands: readonly ClipDrawCommand[], opts: DrawClipFrameOpts = {}): void {
  const qrRenderer = opts.qrRenderer ?? defaultQrPlaceholder;
  for (const cmd of commands) {
    switch (cmd.kind) {
      case 'stage-frame':
        ctx.drawImage(cmd.source, 0, 0, CLIP_WIDTH, CLIP_HEIGHT);
        break;
      case 'chyron':
        drawLowerBanner(ctx, cmd.text, CLIP_HEIGHT - 90);
        break;
      case 'caster-line':
        drawLowerBanner(ctx, cmd.text, CLIP_HEIGHT - 50);
        break;
      case 'replay-chrome':
        drawTopBanner(ctx, cmd.text);
        break;
      case 'end-slate': {
        const size = 320;
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.fillRect(0, 0, CLIP_WIDTH, CLIP_HEIGHT);
        ctx.fillStyle = '#39ff14';
        ctx.font = '36px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(cmd.label, CLIP_WIDTH / 2, CLIP_HEIGHT / 2 - size / 2 - 30);
        ctx.restore();
        qrRenderer(ctx, (CLIP_WIDTH - size) / 2, CLIP_HEIGHT / 2 - size / 2, size, cmd.url);
        break;
      }
    }
  }
}

function drawLowerBanner(ctx: Canvas2DLike, text: string, y: number): void {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, y - 28, CLIP_WIDTH, 40);
  ctx.fillStyle = '#ffffff';
  ctx.font = '24px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 24, y);
  ctx.restore();
}

function drawTopBanner(ctx: Canvas2DLike, text: string): void {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, CLIP_WIDTH, 40);
  ctx.fillStyle = '#ffffff';
  ctx.font = '24px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 24, 28);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// captureStream + the master-bus audio tap (thin real-API glue).
// ---------------------------------------------------------------------------

export interface CaptureStreamCanvas {
  captureStream(frameRate?: number): MediaStream;
}

/** `captureStream(30)` on the COMPOSITOR canvas ONLY — DOM overlays are never captured. */
export function captureCompositorStream(canvas: CaptureStreamCanvas, fps: number = CLIP_CAPTURE_FPS): MediaStream {
  return canvas.captureStream(fps);
}

/**
 * Tap the C9 mixer's master bus via `createMediaStreamDestination` (spec §7.20
 * "the confirmed one-line master-bus tap"). Room voice is structurally absent
 * because the mixer never contains it (§6.2, mixer.ts) — this tap can never
 * pick up voice regardless of what's registered on the bus.
 */
export function tapMasterBusForClip(ctx: AudioContext, masterBus: AudioNode): MediaStreamAudioDestinationNode {
  const dest = ctx.createMediaStreamDestination();
  masterBus.connect(dest);
  return dest;
}

// ---------------------------------------------------------------------------
// ClipRecorder — the idle → recording → finalizing → delivered FSM (pure).
// ---------------------------------------------------------------------------

export type ClipState = 'idle' | 'recording' | 'finalizing' | 'delivered';

export class ClipRecorderStateError extends Error {}

/**
 * The clip recorder state machine. Deliberately dumb (no timers, no I/O) —
 * `start`/`stopRecording`/`markDelivered`/`discard` are called by the thin
 * real-capture orchestration (owner/manual-verified). `discard()` is the
 * console's "keep/discard" DISCARD path (spec §7.20); "keep" is simply NOT
 * discarding — the default happy path proceeds to `markDelivered()`.
 */
export class ClipRecorder {
  private _state: ClipState = 'idle';
  private _clipId: string | null = null;

  get state(): ClipState {
    return this._state;
  }
  get clipId(): string | null {
    return this._clipId;
  }

  /** idle → recording. `clipId` is PRE-MINTED by the caller (spec §7.20). */
  start(clipId: string): void {
    if (this._state !== 'idle') {
      throw new ClipRecorderStateError(`ClipRecorder.start: invalid from '${this._state}'`);
    }
    if (!isValidClipId(clipId)) {
      throw new ClipRecorderStateError(`ClipRecorder.start: clipId fails the ${CLIP_ID_RE} shape gate`);
    }
    this._clipId = clipId;
    this._state = 'recording';
  }

  /** recording → finalizing (MediaRecorder.stop() called; awaiting the final blob / keep-discard). */
  stopRecording(): void {
    if (this._state !== 'recording') {
      throw new ClipRecorderStateError(`ClipRecorder.stopRecording: invalid from '${this._state}'`);
    }
    this._state = 'finalizing';
  }

  /** finalizing → delivered (the POST succeeded). */
  markDelivered(): void {
    if (this._state !== 'finalizing') {
      throw new ClipRecorderStateError(`ClipRecorder.markDelivered: invalid from '${this._state}'`);
    }
    this._state = 'delivered';
  }

  /** Console/keep-discard DISCARD, or an abort — returns to idle from ANY state. */
  discard(): void {
    this._state = 'idle';
    this._clipId = null;
  }

  /** Reset after delivery (or an external bank-and-forget) for the next clip. */
  reset(): void {
    this._state = 'idle';
    this._clipId = null;
  }
}

// ---------------------------------------------------------------------------
// ClipDirector — auto-first-per-rotation + SAVE CLIP override gating (pure).
// ---------------------------------------------------------------------------

export interface ClipDirectorOpts {
  /** clipId minter (defaults to `mintClipId(webCryptoRandomBytes)`; tests inject a fake). */
  mintId?: () => string;
}

/**
 * Gates the TWO clip triggers (spec §7.20):
 *   • auto-first: exactly ONE auto-clip per rotation, at FINALE→STATS, and ONLY
 *     when a highlight actually aired (the caller reuses C21's OWN
 *     `StageReplay.replayLastHighlight()` — the SAME min-activity gate, never
 *     duplicated here).
 *   • SAVE CLIP: the stage-local hotkey / console override — always allowed
 *     (no rotation gate; a visitor can save their OWN catch any time).
 */
export class ClipDirector {
  private readonly mintId: () => string;
  private autoClippedThisRotation = false;

  constructor(opts: ClipDirectorOpts = {}) {
    this.mintId = opts.mintId ?? (() => mintClipId(webCryptoRandomBytes));
  }

  /** Call on entering a fresh rotation (LOBBY) — re-arms the auto-first gate. */
  onRotationStart(): void {
    this.autoClippedThisRotation = false;
  }

  /**
   * Call at the FINALE→STATS transition with whether a highlight replay just
   * aired. Returns a freshly-minted clipId to start recording, or null when
   * gated (no highlight aired, or this rotation already auto-clipped).
   */
  maybeAutoClip(replayAired: boolean): string | null {
    if (!replayAired || this.autoClippedThisRotation) return null;
    this.autoClippedThisRotation = true;
    return this.mintId();
  }

  /** SAVE CLIP hotkey / console override. Always allowed; mints a fresh clipId. */
  saveClip(): string {
    return this.mintId();
  }
}

// ---------------------------------------------------------------------------
// ClipBank — the no-uplink rung (spec §7.20 "clips bank locally").
// ---------------------------------------------------------------------------

export interface BankedClip {
  clipId: string;
  /** The local copy (kept until a successful upload, or forever offline). Opaque. */
  blob: unknown;
  createdAt: number;
  delivered: boolean;
}

/** Copy shown while a clip is banked but not yet uploaded (spec §7.20 no-uplink rung). */
export const CLIP_NO_UPLINK_COPY = 'your clip posts to the club Discord tonight';

/** The STATS/RESET "take it home" card copy (spec §7.20). */
export const CLIP_TAKE_HOME_HEADLINE = 'SCAN TO TAKE YOUR CLIP HOME';

/** The STATS/RESET take-home card duration (spec §7.20 "~20 s"). */
export const CLIP_TAKE_HOME_CARD_MS = 20_000;

export class ClipBank {
  private readonly now: () => number;
  private readonly items = new Map<string, BankedClip>();

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  bank(clipId: string, blob: unknown): void {
    this.items.set(clipId, { clipId, blob, createdAt: this.now(), delivered: false });
  }

  markDelivered(clipId: string): void {
    const it = this.items.get(clipId);
    if (it) it.delivered = true;
  }

  has(clipId: string): boolean {
    return this.items.has(clipId);
  }

  list(): BankedClip[] {
    return [...this.items.values()];
  }

  /** Clips banked locally but never successfully uploaded (the no-uplink rung). */
  pending(): BankedClip[] {
    return this.list().filter((c) => !c.delivered);
  }
}

// ---------------------------------------------------------------------------
// Delivery — the upload + the QR retrieval URL (fetch injected; pure given it).
// ---------------------------------------------------------------------------

/** `GET /api/clips/:id` — the URL the end-slate QR encodes (spec §7.20). */
export function clipRetrievalUrl(origin: string, clipId: string): string {
  return `${origin.replace(/\/$/, '')}/api/clips/${clipId}`;
}

export interface PostClipOpts {
  origin: string;
  roomId: string;
  ownerToken: string;
  clipId: string;
  contentType: string;
  /** The finished clip bytes (a Blob in real use; tests pass any BodyInit-ish value). */
  body: unknown;
  /** Injected fetch (tests supply a mock; defaults to globalThis.fetch). */
  fetchFn?: typeof fetch;
}

export interface PostClipResult {
  ok: boolean;
  status: number;
}

/**
 * `POST /api/clips` — ownerToken/roomId/clipId ride HEADERS, never a URL (the
 * C4 treatment, spec §7.20). Returns `{ok:false, status:0}` when no fetch is
 * available (no-uplink rung — the caller falls back to {@link ClipBank}).
 */
export async function postClip(opts: PostClipOpts): Promise<PostClipResult> {
  const f = opts.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!f) return { ok: false, status: 0 };
  try {
    const res = await f(`${opts.origin.replace(/\/$/, '')}/api/clips`, {
      method: 'POST',
      headers: {
        'X-Owner-Token': opts.ownerToken,
        'X-Room-Id': opts.roomId,
        'X-Clip-Id': opts.clipId,
        'Content-Type': opts.contentType,
      },
      body: opts.body as BodyInit,
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

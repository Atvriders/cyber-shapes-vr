/**
 * funnel/wisp3d.ts — the wisp entry's LAZY 3D magic-window renderer + the phone
 * AIM model (spec §7.4).
 *
 * This is the ONLY funnel module that imports `three`. It is loaded via a dynamic
 * `import('./wisp3d.js')` from wisp.ts AFTER the WS join completes (spec §5.7
 * "join-first, render-later"), so `three` lands in its own async chunk and NEVER
 * bloats the wisp ENTRY chunk (budgeted < 300 KB gz initial).
 *
 * Aim model (spec §7.4):
 *   • touch-drag with an AUTO-AIM cone is the DEFAULT (no permission, works in the
 *     in-app QR browsers that never grant motion);
 *   • gyro is progressive enhancement — a camera-RELATIVE ray (deviceorientation
 *     is relative since Chrome 50), double-tap recenter, and motion mode gated on
 *     receiving an ACTUAL deviceorientation event within ~1 s of the permission
 *     grant (so in-app browsers fall back silently);
 *   • `DeviceOrientationEvent.requestPermission()` is called INSIDE the tap
 *     handler (iOS requires a user-gesture-scoped call).
 *
 * The PURE aim helpers below carry no `three` dependency, so the server-clamp /
 * feedback logic and the tests exercise them without a GL context.
 */

import * as THREE from 'three';
import {
  PocketDvr,
  SHOWPIECE_KIND,
  VOTE_KIND,
  OPCODES,
  CROWD_KIND,
  decodeBinary,
  type DvrTier,
  type ResimPose,
  type ServerMsg,
} from '@cyber-shapes/shared';

export interface WispView {
  /** Stop the render loop and release GL resources. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// PURE aim model (no three) — tested directly.
// ---------------------------------------------------------------------------

/** A 3-vector (aim ray direction). */
export interface AimVec3 {
  x: number;
  y: number;
  z: number;
}

/** A candidate the auto-aim cone can snap onto (a shape / target in the world). */
export interface AimTarget {
  id: string;
  /** Unit direction from the camera to the target. */
  dir: AimVec3;
}

function norm(v: AimVec3): AimVec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
function dot(a: AimVec3, b: AimVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Touch-drag DEFAULT with an auto-aim cone (spec §7.4): given the raw drag ray
 * and the candidate targets, snap to the nearest target INSIDE the cone
 * (`coneCos` = cos(half-angle)). Returns null when nothing is in the cone (free
 * aim — the pulse fires along the raw ray). Pure + deterministic.
 */
export function autoAim(
  ray: AimVec3,
  targets: readonly AimTarget[],
  coneCos: number
): AimTarget | null {
  const r = norm(ray);
  let best: AimTarget | null = null;
  let bestDot = coneCos;
  for (const t of targets) {
    const d = dot(r, norm(t.dir));
    if (d >= bestDot) {
      bestDot = d;
      best = t;
    }
  }
  return best;
}

/** A device heading (yaw/pitch in radians) — the gyro's relative orientation. */
export interface Heading {
  yaw: number;
  pitch: number;
}

/**
 * Gyro aim is a camera-RELATIVE ray (spec §7.4): the ray is computed RELATIVE to
 * a recenter reference (double-tap re-zeros `ref`), never an absolute compass
 * heading. At the reference exactly, the ray points straight forward (−Z). Pure.
 */
export function cameraRelativeAim(now: Heading, ref: Heading): AimVec3 {
  const dYaw = now.yaw - ref.yaw;
  const dPitch = now.pitch - ref.pitch;
  // Forward is −Z; +yaw turns toward +X; +pitch tilts toward +Y.
  const cp = Math.cos(dPitch);
  return norm({
    x: Math.sin(dYaw) * cp,
    y: Math.sin(dPitch),
    z: -Math.cos(dYaw) * cp,
  });
}

/** Motion mode must see a real deviceorientation event within this window of the grant. */
export const GYRO_GRANT_WINDOW_MS = 1000;

/**
 * Event-gate for gyro motion mode (spec §7.4): after the permission GRANT, motion
 * mode activates ONLY if an actual `deviceorientation` event arrives within
 * ~1 s. In-app QR browsers grant permission but never emit an event → the gate
 * stays inactive and the phone silently keeps touch-drag aim. Fake-time friendly.
 */
export class GyroGate {
  private _grantedAt: number | null = null;
  private _active = false;

  constructor(private readonly _now: () => number = () => Date.now()) {}

  /** Permission just granted — start the ≤ 1 s window. */
  onGranted(): void {
    this._grantedAt = this._now();
  }

  /** A real deviceorientation event arrived — activate IFF inside the window. */
  onEvent(): void {
    if (this._grantedAt === null) return; // no grant yet → touch-drag stays default.
    if (this._now() - this._grantedAt <= GYRO_GRANT_WINDOW_MS) this._active = true;
  }

  /** True once motion mode is live (an event landed inside the grant window). */
  get active(): boolean {
    return this._active;
  }
}

/** The shape of `DeviceOrientationEvent` on iOS (requestPermission) — Android lacks it. */
interface DeviceOrientationEventWithPermission {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

/**
 * Request gyro permission (spec §7.4 — MUST be called synchronously INSIDE the
 * tap handler for iOS to honour the user gesture). Returns:
 *   • 'granted'/'denied' from iOS's `DeviceOrientationEvent.requestPermission()`;
 *   • 'unsupported' when there is no requestPermission (Android — gyro needs no
 *     prompt) so the caller can wire deviceorientation listeners directly.
 */
export async function requestGyroPermission(
  deviceOrientationEvent: DeviceOrientationEventWithPermission
): Promise<'granted' | 'denied' | 'unsupported'> {
  const req = deviceOrientationEvent?.requestPermission;
  if (typeof req !== 'function') return 'unsupported';
  try {
    const res = await req.call(deviceOrientationEvent);
    return res === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

// ---------------------------------------------------------------------------
// Over-cap spectate page (spec §7.4 — "over-cap → spectate page with queue pos").
// ---------------------------------------------------------------------------

export interface SpectateInfo {
  /** 1-based position in the wisp queue. */
  queuePosition: number;
  /** The callsign already reserved for this device (surfaced so it feels held). */
  callsign: string;
}

/**
 * Render the over-cap spectate page: the wisp room is full, so this phone watches
 * the big screen and holds its queue position until a slot frees (spec §7.4).
 * DOM-only (no three) so an over-cap phone never pays the 3D download.
 */
export function renderSpectatePage(root: HTMLElement, info: SpectateInfo): void {
  const doc = root.ownerDocument;
  root.textContent = '';
  const panel = doc.createElement('div');
  panel.className = 'wisp-spectate';
  panel.dataset['role'] = 'spectate';

  const title = doc.createElement('div');
  title.className = 'wisp-spectate-title';
  title.textContent = 'THE VOID IS FULL — YOU ARE IN THE QUEUE';
  panel.appendChild(title);

  const queue = doc.createElement('div');
  queue.className = 'wisp-spectate-queue';
  queue.dataset['role'] = 'queue';
  queue.textContent = `#${info.queuePosition} in line`;
  panel.appendChild(queue);

  const cs = doc.createElement('div');
  cs.className = 'wisp-spectate-callsign';
  cs.textContent = `Your callsign ${info.callsign} is reserved — watch the big screen`;
  panel.appendChild(cs);

  root.appendChild(panel);
}

// ---------------------------------------------------------------------------
// C30 MF4 — the rewound-pose render FEED (spec §7.19 "orbit the frozen throw").
//
// `PocketDvr.poses()` computes the correct NAMESPACED rewound poses, but nothing
// consumed them for 3D — the magic window drew only a decorative orb, so scrubbing
// produced no visible rewound world. This is the render CONSUMPTION seam: a pure
// function over a minimal scene ADAPTER (THREE-free) so it is unit-covered without
// a WebGL context (pixel-exact look is owner/hardware-verified). `mountWispView`
// supplies a THREE-backed adapter; a test supplies a fake one.
// ---------------------------------------------------------------------------

/**
 * The minimal 3D-scene seam the DVR pose renderer drives. THREE-free so the feed is
 * testable headlessly. `mountWispView` implements it over real meshes.
 */
export interface DvrSceneAdapter {
  /** Create-or-move the rewound replay shape `id` to `pose` (this frame). */
  upsert(id: string, pose: ResimPose): void;
  /** Remove a rewound replay shape no longer present this frame. */
  remove(id: string): void;
  /** The replay ids currently in the scene (to diff against this frame's poses). */
  ids(): string[];
  /** Show (true) or hide (false) the decorative/live orb (hidden while rewound). */
  setDecorative(visible: boolean): void;
}

/**
 * Feed ONE frame of the DVR into the 3D scene (MF4). While the DVR is SCRUBBED, the
 * namespaced {@link PocketDvr.poses} rewound shapes are drawn (orbit-able, frozen
 * surface) and the decorative orb is hidden; at LIVE (or with no DVR) the replay
 * shapes are removed and the decorative/live view resumes. Pure over the adapter.
 */
export function renderDvrFrame(adapter: DvrSceneAdapter, dvr: PocketDvr | null | undefined): void {
  const poses = dvr && !dvr.isLive ? dvr.poses() : [];
  if (poses.length === 0) {
    // Live (or no DVR): drop any rewound shapes, resume the decorative/live view.
    for (const id of adapter.ids()) adapter.remove(id);
    adapter.setDecorative(true);
    return;
  }
  const seen = new Set<string>();
  for (const { id, pose } of poses) {
    adapter.upsert(id, pose);
    seen.add(id);
  }
  for (const id of adapter.ids()) if (!seen.has(id)) adapter.remove(id);
  adapter.setDecorative(false); // hide the decorative orb while rewound.
}

// ---------------------------------------------------------------------------
// The lazy 3D magic-window (three) — mounted only after join.
// ---------------------------------------------------------------------------

/**
 * Mount the wisp magic-window 3D view into `canvas`. Called only after join.
 * Wires touch-drag aim by default; gyro is progressive enhancement (permission
 * requested inside the first tap; motion mode is event-gated ≤ 1 s post-grant).
 * Guarded so a headless/no-WebGL environment (tests) degrades to a no-op.
 *
 * C30 MF4: pass the SAME {@link PocketDvr} the scrub UI drives (as `opts.dvr`, or
 * lazily via `opts.getDvr` when the DVR is created AFTER the view mounts) to draw
 * the rewound namespaced poses in the magic window while scrubbed — the decorative
 * orb resumes on jump-to-live. The pose feed is the pure, tested {@link renderDvrFrame}.
 */
export function mountWispView(
  canvas: HTMLCanvasElement,
  colorIndex = 0,
  opts: { dvr?: PocketDvr; getDvr?: () => PocketDvr | undefined } = {}
): WispView {
  const resolveDvr = (): PocketDvr | undefined => (opts.getDvr ? opts.getDvr() : opts.dvr);
  let renderer: THREE.WebGLRenderer | null = null;
  let raf = 0;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    // No WebGL (in-app browser / test) — the phone still shows the DOM "YOU ARE
    // IN" panel from wisp.ts; the 3D window is progressive enhancement.
    return { dispose() {} };
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  camera.position.set(0, 0, 6);

  const palette = [0x00ffff, 0xff00ff, 0x00ff88, 0xffee00, 0xff5533, 0x8855ff];
  const color = palette[colorIndex % palette.length];
  const orb = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color, wireframe: true })
  );
  scene.add(orb);

  // ── C30 MF4: the rewound-pose scene adapter (frozen surface = SOLID material). ─
  const replayMeshes = new Map<string, THREE.Mesh>();
  const replayGeom = new THREE.IcosahedronGeometry(0.8, 1);
  const dvrAdapter: DvrSceneAdapter = {
    upsert(id, pose) {
      let mesh = replayMeshes.get(id);
      if (!mesh) {
        mesh = new THREE.Mesh(replayGeom, new THREE.MeshBasicMaterial({ color }));
        replayMeshes.set(id, mesh);
        scene.add(mesh);
      }
      mesh.position.set(pose.p.x, pose.p.y, pose.p.z);
    },
    remove(id) {
      const mesh = replayMeshes.get(id);
      if (!mesh) return;
      scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
      replayMeshes.delete(id);
    },
    ids() {
      return [...replayMeshes.keys()];
    },
    setDecorative(visible) {
      orb.visible = visible;
    },
  };

  // ── Aim state: touch-drag by default; gyro gated behind the tap-grant. ──────
  const gyroGate = new GyroGate();
  const recenter: Heading = { yaw: 0, pitch: 0 };
  let liveHeading: Heading = { yaw: 0, pitch: 0 };
  let lastTapMs = 0;

  const onOrientation = (ev: DeviceOrientationEventInit): void => {
    // deviceorientation alpha (yaw)/beta (pitch) in degrees → radians.
    const yaw = ((ev.alpha ?? 0) * Math.PI) / 180;
    const pitch = ((ev.beta ?? 0) * Math.PI) / 180;
    liveHeading = { yaw, pitch };
    gyroGate.onEvent(); // event-gate: activates motion mode iff inside the grant window.
  };

  const win = globalThis as unknown as {
    addEventListener?: typeof window.addEventListener;
    removeEventListener?: typeof window.removeEventListener;
    DeviceOrientationEvent?: DeviceOrientationEventWithPermission;
  };

  // The first tap: request gyro permission INSIDE the handler (iOS gesture rule),
  // and double-tap (< 300 ms) recenters the camera-relative ray.
  const onTap = (): void => {
    const now = Date.now();
    if (now - lastTapMs < 300) {
      // Double-tap recenter — re-zero the relative ray to the current heading.
      recenter.yaw = liveHeading.yaw;
      recenter.pitch = liveHeading.pitch;
    }
    lastTapMs = now;
    const doe = win.DeviceOrientationEvent;
    if (doe) {
      void requestGyroPermission(doe).then((res) => {
        if (res === 'granted' || res === 'unsupported') {
          gyroGate.onGranted();
          win.addEventListener?.('deviceorientation', onOrientation as EventListener);
        }
      });
    }
  };
  canvas.addEventListener?.('pointerdown', onTap);

  const resize = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer?.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  win.addEventListener?.('resize', resize);

  const loop = () => {
    // C30 MF4: while SCRUBBED, draw the DVR's rewound namespaced poses (frozen,
    // orbit-able) and hide the decorative orb; at LIVE the orb resumes. The feed is
    // the pure renderDvrFrame; the orb aim below only matters when decorative.
    renderDvrFrame(dvrAdapter, resolveDvr());
    // When motion mode is live, point the orb along the camera-relative ray;
    // otherwise it idles (touch-drag would rotate it — omitted in this minimal view).
    if (gyroGate.active) {
      const ray = cameraRelativeAim(liveHeading, recenter);
      orb.position.set(ray.x * 2, ray.y * 2, 6 + ray.z * 2);
    } else {
      orb.rotation.y += 0.01;
      orb.rotation.x += 0.005;
    }
    renderer?.render(scene, camera);
    raf =
      (globalThis as unknown as { requestAnimationFrame?: (cb: FrameRequestCallback) => number })
        .requestAnimationFrame?.(loop) ?? 0;
  };
  loop();

  return {
    dispose() {
      if (raf) {
        (globalThis as unknown as { cancelAnimationFrame?: (h: number) => void }).cancelAnimationFrame?.(
          raf
        );
      }
      win.removeEventListener?.('resize', resize);
      win.removeEventListener?.('deviceorientation', onOrientation as EventListener);
      canvas.removeEventListener?.('pointerdown', onTap);
      for (const id of dvrAdapter.ids()) dvrAdapter.remove(id); // dispose replay mats
      replayGeom.dispose();
      orb.geometry.dispose();
      (orb.material as THREE.Material).dispose();
      renderer?.dispose();
    },
  };
}

// ===========================================================================
// C30 — F19 Pocket DVR (spec §7.19): the phone SCRUB UI + the message ingest.
//
// This lives in the LAZY wisp3d chunk (never the wisp ENTRY / main) so the DVR
// only downloads with the 3D magic window, after join — the bundle-hygiene rule
// (spec §7.19: "the DVR module lazy-loads with the wisp 3D chunk"; the entry
// stays < 300 KB gz + three-free, asserted by tools/check-bundle-size.mjs).
//
// The pure scrub/buffer/resim engine is the SHARED {@link PocketDvr}; this file
// owns only the DOM surface + the ServerMsg → DVR mapping. Copy is
// SHAPE-TRAJECTORY-scoped ("rewind the shot") — the audience pose subset is
// HEAD-ONLY, so NO catch-centric copy (a settled C25 negotiation item).
// ===========================================================================

/** Ingest bookkeeping — the last coalesced tick (the release resim-seed tick). */
export interface DvrIngestState {
  lastTick: number;
  /**
   * C30 MF3: whether a crowd-supernova CHARGE window is currently active. The real
   * charge signal is the BINARY `CHARGE_STATE` (0x2A/0x01); we fire CHARGE_START on
   * the FIRST charge frame of a window (dedup) and reset when the phase leaves
   * FINALE (the encore runs by HOLDING FINALE) so a LATER encore fires again.
   */
  chargeActive: boolean;
}

/** Fresh ingest state (lastTick 0 until the first coalesced frame arrives). */
export function newDvrIngestState(): DvrIngestState {
  return { lastTick: 0, chargeActive: false };
}

/**
 * Map ONE decoded ServerMsg into the DVR. PURE (no DOM): the wisp/audience wire
 * carries a DECIMATED, position-only world (`wisp-coalesced`) + the release event
 * ({t:'grab', peerId:null, pos, vel} — the §3 accommodation #5 resim seed) + the
 * booth-critical yield signals (showpiece START / vote OPEN). The crowd-charge
 * yield is driven by the REAL binary CHARGE_STATE — see {@link ingestDvrBinary} —
 * NOT a phase name (the encore never renames its phase). Unknown families are
 * ignored (forward-compatible).
 */
export function ingestDvrMessage(
  dvr: PocketDvr,
  msg: ServerMsg,
  now: number,
  state: DvrIngestState
): void {
  switch (msg.t) {
    case 'wisp-coalesced': {
      // Head-only decimated positions — push as position-only samples (no v).
      state.lastTick = msg.tick;
      const zero = { x: 0, y: 0, z: 0 };
      dvr.push(
        now,
        msg.shapes.map((s) => ({ tick: msg.tick, id: s.id, p: s.p, r: { ...zero }, v: { ...zero } }))
      );
      break;
    }
    case 'welcome':
    case 'audience-keyframe': {
      // Seed each shape's type/scale from the world snapshot (the decimated stream
      // omits both, but the resim keyframe needs them).
      for (const s of msg.shapes) dvr.setShapeMeta(s.id, s.type, s.scale);
      break;
    }
    case 'spawn':
      dvr.setShapeMeta(msg.shape.id, msg.shape.type, msg.shape.scale);
      break;
    case 'grab':
      // A RELEASE (peerId null) carries the authoritative {pos, vel} — the resim
      // SEED that makes the ballistic "rewind the shot" possible (the §14 gate).
      if (msg.peerId === null && msg.pos && msg.vel) {
        dvr.onRelease({ tick: state.lastTick, id: msg.id, p: msg.pos, v: msg.vel });
      }
      break;
    case 'showpiece':
      if (msg.kind === SHOWPIECE_KIND.START) dvr.onYieldSignal('SHOWPIECE_START');
      break;
    case 'vote':
      if (msg.kind === VOTE_KIND.OPEN) dvr.onYieldSignal('VOTE_OPEN');
      break;
    case 'phase-state':
      // C30 MF3: the encore runs by HOLDING FINALE and NEVER renames its phase, so
      // the old `/charge|encore/` text proxy was ALWAYS false — a real crowd
      // supernova never snapped a scrubbed wisp to live. The charge yield now rides
      // the REAL binary CHARGE_STATE (ingestDvrBinary). Here we only RESET the
      // charge-window latch when the phase leaves FINALE, so a LATER encore's first
      // CHARGE_STATE fires CHARGE_START again.
      if (msg.phase !== 'FINALE') state.chargeActive = false;
      break;
    default:
      break;
  }
}

/**
 * C30 MF3 — the REAL crowd-supernova charge yield. The charge signal is the BINARY
 * `CHARGE_STATE` (opcode 0x2A CROWD_CUE, kind 0x01 CHARGE — spec Appendix B), NOT a
 * phase name. Decode any binary frame here (voice/music/other opcodes are ignored);
 * on the FIRST CHARGE_STATE of a charge window (deduped via `state.chargeActive`,
 * reset on leaving FINALE) fire the booth-critical `CHARGE_START` yield so a
 * scrubbed viewer snaps to live within one frame (§7.19). Accepts an ArrayBuffer or
 * any ArrayBufferView (a WS binary frame). Pure (no DOM).
 */
export function ingestDvrBinary(
  dvr: PocketDvr,
  data: ArrayBuffer | ArrayBufferView,
  state: DvrIngestState
): void {
  const buf: ArrayBuffer =
    data instanceof ArrayBuffer
      ? data
      : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  if (buf.byteLength < 2) return;
  const view = new DataView(buf);
  const opcode = view.getUint8(0);
  const kind = view.getUint8(1);
  // Only a CROWD_CUE/CHARGE frame is a charge signal; everything else is ignored
  // (peek the preamble first so decodeBinary is never handed a non-codec opcode).
  if (opcode !== OPCODES.CROWD_CUE || kind !== CROWD_KIND.CHARGE) return;
  // A real decode of the Appendix B CHARGE_STATE frame (validates the layout).
  try {
    decodeBinary(buf);
  } catch {
    return; // malformed — not a real charge frame.
  }
  if (state.chargeActive) return; // already yielded for this charge window (dedup).
  state.chargeActive = true;
  dvr.onYieldSignal('CHARGE_START');
}

/** A mounted Pocket DVR UI. `update(now)` refreshes it; `dispose()` tears it down. */
export interface DvrUiHandle {
  update(now: number): void;
  dispose(): void;
}

/** Scrub-bar resolution (slider integer steps across the retained rewind range). */
const DVR_SLIDER_STEPS = 1000;

/**
 * Build the Pocket DVR scrub UI into `root` (DOM-only, no three): a scrub slider,
 * the mandatory "REWOUND // T-…s" badge, a speed pill (1× / 0.25×), a JUMP-TO-LIVE
 * button, a yield banner, and §5.3 gap shading on the track. Consumes the shared
 * {@link PocketDvr}; `update(now)` drives the idle auto-return + repaints state.
 */
export function mountDvrUi(root: HTMLElement, dvr: PocketDvr, doc: Document = root.ownerDocument): DvrUiHandle {
  const panel = doc.createElement('div');
  panel.className = 'dvr';
  panel.dataset['role'] = 'dvr';

  const badge = doc.createElement('div');
  badge.className = 'dvr-badge';
  badge.dataset['role'] = 'dvr-badge';
  badge.hidden = true;
  panel.appendChild(badge);

  const track = doc.createElement('div');
  track.className = 'dvr-track';
  const gapLayer = doc.createElement('div');
  gapLayer.className = 'dvr-gaps';
  gapLayer.dataset['role'] = 'dvr-gaps';
  track.appendChild(gapLayer);

  const scrub = doc.createElement('input');
  scrub.type = 'range';
  scrub.className = 'dvr-scrub';
  scrub.dataset['role'] = 'dvr-scrub';
  scrub.min = '0';
  scrub.max = String(DVR_SLIDER_STEPS);
  scrub.value = String(DVR_SLIDER_STEPS); // start at LIVE (far right)
  track.appendChild(scrub);
  panel.appendChild(track);

  const controls = doc.createElement('div');
  controls.className = 'dvr-controls';

  const speed = doc.createElement('span');
  speed.className = 'dvr-speed';
  speed.dataset['role'] = 'dvr-speed';
  speed.textContent = '1×';
  controls.appendChild(speed);

  const live = doc.createElement('button');
  live.type = 'button';
  live.className = 'dvr-live';
  live.dataset['role'] = 'dvr-live';
  live.textContent = 'JUMP TO LIVE';
  controls.appendChild(live);
  panel.appendChild(controls);

  const banner = doc.createElement('div');
  banner.className = 'dvr-banner';
  banner.dataset['role'] = 'dvr-banner';
  banner.hidden = true;
  panel.appendChild(banner);

  root.appendChild(panel);

  const nowFn = (): number =>
    (globalThis as unknown as { Date?: { now(): number } }).Date?.now?.() ?? 0;

  /** Map the slider step [0..STEPS] to a wall time in [oldest, newest]. */
  function stepToWall(step: number): number {
    const lo = dvr.oldestWall();
    const hi = dvr.liveWall();
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return hi;
    return lo + ((hi - lo) * step) / DVR_SLIDER_STEPS;
  }

  const onScrub = (): void => {
    const step = Number(scrub.value);
    if (step >= DVR_SLIDER_STEPS) {
      dvr.jumpToLive();
    } else {
      dvr.scrubTo(stepToWall(step), nowFn());
    }
  };
  scrub.addEventListener('input', onScrub);

  const onLive = (): void => {
    dvr.jumpToLive();
    scrub.value = String(DVR_SLIDER_STEPS);
  };
  live.addEventListener('click', onLive);

  function update(now: number): void {
    dvr.tick(now); // idle auto-return (~10 s)

    // The mandatory REWOUND badge (never mistake a paused phone for a frozen room).
    const b = dvr.badge();
    badge.hidden = !b.rewound;
    badge.textContent = b.text;
    panel.dataset['rewound'] = b.rewound ? 'true' : 'false';

    // Speed pill: 1× default, 0.25× only inside a resimmed ballistic segment.
    speed.textContent = dvr.speed() === 1 ? '1×' : '0.25×';

    // Yield banner (SHOWPIECE/CHARGE/VOTE snapped you back to live).
    const y = dvr.yieldBanner();
    banner.hidden = y === null;
    if (y) banner.textContent = yieldCopy(y);

    // When following live, keep the slider pinned right (drain-forward converged).
    if (dvr.isLive) scrub.value = String(DVR_SLIDER_STEPS);

    // §5.3 gap shading on the track (background-tab stalls).
    renderGaps();
  }

  function renderGaps(): void {
    const lo = dvr.oldestWall();
    const hi = dvr.liveWall();
    const span = hi - lo;
    gapLayer.textContent = '';
    if (!Number.isFinite(span) || span <= 0) return;
    for (const g of dvr.gaps(1_000)) {
      const seg = doc.createElement('span');
      seg.className = 'dvr-gap';
      seg.style.left = `${(100 * (g.from - lo)) / span}%`;
      seg.style.width = `${(100 * (g.to - g.from)) / span}%`;
      gapLayer.appendChild(seg);
    }
  }

  return {
    update,
    dispose() {
      scrub.removeEventListener('input', onScrub);
      live.removeEventListener('click', onLive);
      panel.remove();
    },
  };
}

/** Human copy for a yield banner — shape-trajectory-scoped, never catch-centric. */
function yieldCopy(sig: string): string {
  switch (sig) {
    case 'SHOWPIECE_START':
      return 'LIVE — the showpiece is on';
    case 'CHARGE_START':
      return 'LIVE — the crowd is charging';
    case 'VOTE_OPEN':
      return 'LIVE — a vote just opened';
    default:
      return 'LIVE';
  }
}

/** A running Pocket DVR (UI + live socket feed). */
export interface PocketDvrHandle {
  dvr: PocketDvr;
  dispose(): void;
}

export interface StartPocketDvrOpts {
  tier?: DvrTier;
  /** The live socket whose text frames feed the DVR (JSON ServerMsgs). */
  ws?: Pick<WebSocket, 'addEventListener' | 'removeEventListener'>;
  doc?: Document;
  now?: () => number;
}

/**
 * Wire a live Pocket DVR into `root`: construct the shared engine, mount the scrub
 * UI, subscribe the socket's text frames through {@link ingestDvrMessage}, and run
 * an rAF repaint loop. Called from the wisp ENTRY (wisp.ts) AFTER join via the
 * already-lazy wisp3d module, so the DVR never enters the entry/main chunk.
 */
export function startPocketDvr(root: HTMLElement, opts: StartPocketDvrOpts = {}): PocketDvrHandle {
  const doc = opts.doc ?? root.ownerDocument;
  const now = opts.now ?? (() => (globalThis as unknown as { Date?: { now(): number } }).Date?.now?.() ?? 0);
  const dvr = new PocketDvr(opts.tier ?? 'wisp');
  const ui = mountDvrUi(root, dvr, doc);
  const state = newDvrIngestState();

  const onMessage = (ev: MessageEvent): void => {
    if (typeof ev.data !== 'string') {
      // C30 MF3: a BINARY frame may be the real CHARGE_STATE (0x2A) — the crowd
      // supernova charge yield. The socket is `binaryType:'arraybuffer'` (join.ts).
      if (ev.data instanceof ArrayBuffer) ingestDvrBinary(dvr, ev.data, state);
      return;
    }
    try {
      const msg = JSON.parse(ev.data) as ServerMsg;
      ingestDvrMessage(dvr, msg, now(), state);
    } catch {
      // Not a JSON ServerMsg — ignore.
    }
  };
  opts.ws?.addEventListener?.('message', onMessage as EventListener);

  let raf = 0;
  const raf1 = (globalThis as unknown as { requestAnimationFrame?: (cb: FrameRequestCallback) => number })
    .requestAnimationFrame;
  const caf = (globalThis as unknown as { cancelAnimationFrame?: (h: number) => void }).cancelAnimationFrame;
  const loop = (): void => {
    ui.update(now());
    raf = raf1?.(loop) ?? 0;
  };
  if (raf1) loop();

  return {
    dvr,
    dispose() {
      if (raf && caf) caf(raf);
      opts.ws?.removeEventListener?.('message', onMessage as EventListener);
      ui.dispose();
    },
  };
}

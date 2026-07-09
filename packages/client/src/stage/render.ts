/**
 * render.ts — the stage 3D render governor (C9, spec §7.1 / §6.5). LAZY-loaded.
 *
 * This is the ONLY stage module that statically imports THREE, so it lands in an
 * async chunk behind `import('./render.js')` in stage.ts (join-first — three is
 * never in the stage ENTRY graph; the size gate stays green). It attaches a
 * governed render loop to a live {@link Stage}: it drives `stage.update(dt)` each
 * frame and points the camera per the returned Shot, applying the §6.5 stage-
 * laptop budget:
 *   • internal render capped at 1080p + upscale (dynamic-resolution governor);
 *   • HALF-RES bloom (the bloom pass runs at ½ the internal resolution);
 *   • a render-stall watchdog: if a frame hasn't advanced within RENDER_STALL_MS
 *     the kiosk auto-reloads (spec §7.1 kiosk resilience).
 *
 * Visuals are manual-verify (the brief unit-tests only the pure brain + mixer);
 * this file is written to typecheck + build. It reuses the existing desktop
 * bloom chain (effects.ts) conceptually but owns its own governed composer so
 * the stage can cap internal resolution independently of the main client.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Stage } from './stage.js';
import type { Shot } from '@cyber-shapes/shared';
import { RENDER_STALL_MS } from './stage.js';
import { GlyphField } from '../glyphRender.js';
import { HudToast } from '../hudToast.js';

/** §6.5 stage-laptop budget: internal render capped at 1080p, then upscaled. */
const MAX_INTERNAL_HEIGHT = 1080;
/** The bloom composer runs at HALF the internal resolution (§6.5). */
const BLOOM_SCALE = 0.5;

/** A running governed renderer handle (dispose on kiosk reload). */
export interface StageRendererHandle {
  dispose(): void;
}

/**
 * Attach a governed render loop to `stage`. Creates its own renderer + scene +
 * bloom composer, mounts the canvas under `#stage-canvas` (or the body), and
 * drives the stage brain. Returns a handle for teardown.
 */
export function attachStageRenderer(stage: Stage, doc: Document): StageRendererHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const mount = doc.getElementById('stage-canvas') ?? doc.body;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050510);
  scene.fog = new THREE.FogExp2(0x0a0020, 0.015);

  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  camera.position.set(0, 1.6, 6);
  camera.lookAt(0, 1, 0);

  // --- Governor: cap internal render height at 1080p, upscale via CSS. -------
  function governedSize(): { w: number; h: number; dpr: number } {
    const win = doc.defaultView ?? (globalThis as unknown as Window);
    const cssW = win.innerWidth || 1920;
    const cssH = win.innerHeight || 1080;
    // Cap the internal buffer height at 1080p; CSS upscales to the panel.
    const scale = cssH > MAX_INTERNAL_HEIGHT ? MAX_INTERNAL_HEIGHT / cssH : 1;
    return { w: Math.round(cssW * scale), h: Math.round(cssH * scale), dpr: 1 };
  }

  // --- Bloom composer at HALF internal resolution (§6.5). --------------------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.2, 0.4, 0.1);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  function applySize(): void {
    const { w, h } = governedSize();
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    composer.setSize(w, h);
    // Half-res bloom: the bloom pass renders into a buffer BLOOM_SCALE the size.
    bloom.setSize(Math.max(1, Math.round(w * BLOOM_SCALE)), Math.max(1, Math.round(h * BLOOM_SCALE)));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  applySize();
  (doc.defaultView ?? (globalThis as unknown as Window)).addEventListener('resize', applySize);

  // --- C12: the Neon Guestbook constellation (spec §7.13 / §6.5). Batched fat
  // lines (nearest 32–48) + Points impostors for the rest, on the spiral shell
  // OUTSIDE the play volume. The pure Stage drives it via the registered sink so
  // birth/backfill/remove/hide flow through without a three import in stage.ts.
  const glyphField = new GlyphField();
  scene.add(glyphField.group);

  // C12: the in-rotation HUD toast (spec §7.13 "in-rotation HUD toast"). Anchored
  // to the camera so it rides the view (never displacing the world — §6.3). On the
  // stage it doubles as the "GLYPH ADDED" beat; the same reusable module is the
  // in-headset toast when the headset client wires it.
  const toast = new HudToast(doc);
  camera.add(toast.mesh);
  scene.add(camera); // ensure the camera (with the toast child) is in the graph
  stage.registerGlyphSink(glyphField, (glyph) => {
    toast.show(`${glyph.callsign} DREW A GLYPH`, glyph.color);
  });

  // --- Camera framing from the current Shot (coarse v1; visuals manual-verify).
  const target = new THREE.Vector3(0, 1, 0);
  function frameShot(shot: Shot): void {
    // v1 framing: WIDE_ESTABLISH pulls back + slow-orbits; FOLLOW/JOIN/GLYPH push
    // in. Detailed easing is a manual-verify polish; the brain owns WHEN to cut,
    // this owns a safe, comfortable WHERE (never moving the world — §6.3).
    switch (shot.kind) {
      case 'WIDE_ESTABLISH': {
        const a = shot.sinceMs / 6000; // slow orbit
        camera.position.set(Math.sin(a) * 7, 2.4, Math.cos(a) * 7);
        target.set(0, 1, 0);
        break;
      }
      case 'GLYPH_BIRTH': {
        // Fly to the birthed glyph on the shell (spec §7.13 "camera flies to the
        // new glyph"). Frame it from just inside the shell, looking outward at it.
        const gp = shot.targetId ? glyphField.slotPosition(shot.targetId) : null;
        if (gp) {
          target.copy(gp);
          // Sit a few units inside the shell along the glyph's radial so the glyph
          // fills the frame against the void.
          const inward = gp.clone().multiplyScalar(0.72);
          camera.position.set(inward.x, gp.y + 1.2, inward.z);
        } else {
          camera.position.set(0, 2.0, 4.5);
          target.set(0, 1, 0);
        }
        break;
      }
      case 'FOLLOW_THROW':
      case 'JOIN_CRANE':
        camera.position.set(0, 2.0, 4.5);
        target.set(0, 1, 0);
        break;
    }
    camera.lookAt(target);
  }

  // --- Governed loop + render-stall watchdog. --------------------------------
  let prev = performance.now();
  let lastFrameAt = prev;
  let running = true;

  const win = doc.defaultView ?? (globalThis as unknown as Window);
  const stallTimer = win.setInterval(() => {
    if (performance.now() - lastFrameAt > RENDER_STALL_MS) {
      // The render loop has stalled — auto-reload the kiosk (spec §7.1).
      win.location?.reload?.();
    }
  }, Math.max(1000, RENDER_STALL_MS / 2));

  function loop(): void {
    if (!running) return;
    const now = performance.now();
    const dt = now - prev;
    prev = now;
    lastFrameAt = now;
    const shot = stage.update(dt);
    frameShot(shot);
    // C12: advance the constellation (chunked backfill + nearest-set re-select)
    // + the HUD toast fade.
    glyphField.update(camera.position);
    toast.update(dt);
    composer.render();
    renderer.setAnimationLoop(loop);
  }
  renderer.setAnimationLoop(loop);

  return {
    dispose(): void {
      running = false;
      win.clearInterval(stallTimer);
      renderer.setAnimationLoop(null);
      win.removeEventListener('resize', applySize);
      glyphField.dispose();
      toast.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

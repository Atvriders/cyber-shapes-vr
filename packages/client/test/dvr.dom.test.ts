/**
 * dvr.dom.test.ts — C30 (F19 Pocket DVR, spec §7.19) client viewer. jsdom.
 *
 * The pure scrub/buffer/resim engine (PocketDvr) is proven in
 * packages/shared/test/replay.test.ts. This covers the LAZY wisp3d-chunk surface:
 *   • the ServerMsg → DVR ingest (decimated wisp-coalesced push + the release seed
 *     + the yield signals);
 *   • the DOM scrub UI: the mandatory REWOUND badge, the 1×/0.25× speed pill, the
 *     JUMP-TO-LIVE control (drain-forward), the yield banner, and §5.3 gap shading.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PocketDvr, SIM_DT, chargeStateFrame, crowdCueFrame, CROWD_CUE_EFFECT } from '@cyber-shapes/shared';
import type { ServerMsg, ResimPose } from '@cyber-shapes/shared';
import {
  mountDvrUi,
  ingestDvrMessage,
  ingestDvrBinary,
  newDvrIngestState,
  renderDvrFrame,
  type DvrSceneAdapter,
} from '../src/funnel/wisp3d.ts';

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
});

function q(sel: string): HTMLElement | null {
  return root.querySelector(sel);
}

describe('C30 Pocket DVR viewer — ingest', () => {
  it('pushes decimated wisp-coalesced positions and seeds the release {pos,vel}', () => {
    const dvr = new PocketDvr('wisp');
    const st = newDvrIngestState();
    // A welcome seeds shape meta (type/scale), then coalesced positions arrive.
    ingestDvrMessage(
      dvr,
      { t: 'welcome', shapes: [{ id: 's1', type: 'cube', scale: 1 } as never] } as ServerMsg,
      0,
      st
    );
    ingestDvrMessage(
      dvr,
      { t: 'wisp-coalesced', tick: 6, shapes: [{ id: 's1', p: { x: 1, y: 2, z: 3 } }] } as ServerMsg,
      100,
      st
    );
    expect(st.lastTick).toBe(6);
    expect(dvr.frameCount()).toBe(1);

    // A release (peerId null) with {pos,vel} becomes the resim seed.
    ingestDvrMessage(
      dvr,
      { t: 'grab', id: 's1', peerId: null, pos: { x: 1, y: 2, z: 3 }, vel: { x: 4, y: 5, z: 0 } } as ServerMsg,
      120,
      st
    );
    expect(dvr.resimSegmentFor('s1')).not.toBeNull();
  });

  function scrubbed(): PocketDvr {
    const dvr = new PocketDvr('wisp');
    dvr.push(0, [{ tick: 0, id: 's1', p: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } }]);
    dvr.push(200, [{ tick: 6, id: 's1', p: { x: 1, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } }]);
    dvr.scrubTo(0, 200);
    return dvr;
  }

  it('JSON yield signals (showpiece START / vote OPEN) snap a scrubbed viewer to live', () => {
    const st = newDvrIngestState();
    const signals: ServerMsg[] = [
      { t: 'showpiece', kind: 0 } as ServerMsg,
      { t: 'vote', kind: 0 } as ServerMsg,
    ];
    for (const msg of signals) {
      const dvr = scrubbed();
      expect(dvr.isLive).toBe(false);
      ingestDvrMessage(dvr, msg, 300, st);
      expect(dvr.isLive).toBe(true); // snapped to live
    }
  });

  it('MF3 — the REAL binary CHARGE_STATE (0x2A) snaps a scrubbed viewer to live; the dead phase-name proxy does NOT', () => {
    const st = newDvrIngestState();

    // The OLD text proxy fired on /charge|encore/ in `msg.phase`, but the encore
    // runs by HOLDING FINALE and never renames — so a REAL phase-state NEVER yields.
    const dead = scrubbed();
    expect(dead.isLive).toBe(false);
    ingestDvrMessage(dead, { t: 'phase-state', phase: 'FINALE', endsAt: null, remainingMs: null } as ServerMsg, 300, st);
    expect(dead.isLive).toBe(false); // FINALE is not a yield — the proxy is gone.

    // The REAL charge signal is the binary CHARGE_STATE (0x2A/0x01). A scrubbed
    // viewer snaps to live within one frame of the real crowd-supernova charge.
    const dvr = scrubbed();
    expect(dvr.isLive).toBe(false);
    ingestDvrBinary(dvr, chargeStateFrame({ charge: 0, crowdSize: 5, fireAtMs: 0 }), st);
    expect(dvr.isLive).toBe(true); // snapped to live on the real charge-start.

    // Dedup: a second CHARGE_STATE in the same window does not re-snap after a rescrub.
    dvr.scrubTo(0, 400);
    expect(dvr.isLive).toBe(false);
    ingestDvrBinary(dvr, chargeStateFrame({ charge: 40, crowdSize: 5, fireAtMs: 0 }), st);
    expect(dvr.isLive).toBe(false); // already yielded for this charge window.

    // A NON-charge CROWD_CUE (0x2A/0x00) is ignored (never a yield).
    const other = scrubbed();
    ingestDvrBinary(
      other,
      crowdCueFrame({ effect: CROWD_CUE_EFFECT.PALETTE_FLASH, colorIndex: 0, intensity: 200, durationMs: 500, seed: 1, fireAtMs: 0 }),
      newDvrIngestState()
    );
    expect(other.isLive).toBe(false); // a CUE is not a charge — no yield.
  });

  it('MF3 — a LATER encore re-fires CHARGE_START after the phase leaves FINALE', () => {
    const st = newDvrIngestState();
    const dvr = scrubbed();
    ingestDvrBinary(dvr, chargeStateFrame({ charge: 0, crowdSize: 5, fireAtMs: 0 }), st);
    expect(dvr.isLive).toBe(true); // first encore charge
    // The encore ends → phase leaves FINALE → the charge latch resets.
    ingestDvrMessage(dvr, { t: 'phase-state', phase: 'STATS', endsAt: null, remainingMs: null } as ServerMsg, 400, st);
    // A NEW encore, later: its first CHARGE_STATE snaps a re-scrubbed viewer again.
    dvr.scrubTo(0, 600);
    expect(dvr.isLive).toBe(false);
    ingestDvrBinary(dvr, chargeStateFrame({ charge: 0, crowdSize: 8, fireAtMs: 0 }), st);
    expect(dvr.isLive).toBe(true);
  });
});

describe('C30 Pocket DVR viewer — MF4 rewound-pose render consumer', () => {
  /** A fake THREE-free scene adapter that records what the render feed drives. */
  function fakeAdapter(): DvrSceneAdapter & { meshes: Map<string, ResimPose>; decorative: boolean } {
    const meshes = new Map<string, ResimPose>();
    return {
      meshes,
      decorative: true,
      upsert(id, pose) { this.meshes.set(id, pose); },
      remove(id) { this.meshes.delete(id); },
      ids() { return [...this.meshes.keys()]; },
      setDecorative(v) { this.decorative = v; },
    };
  }

  it('feeds dvr.poses() (namespaced) into the scene WHILE SCRUBBED, and the live source (orb) at live', () => {
    const dvr = new PocketDvr('wisp');
    dvr.setShapeMeta('s1', 'icosahedron', 1);
    dvr.onRelease({ tick: 0, id: 's1', p: { x: 0, y: 2, z: 0 }, v: { x: 6, y: 5, z: 0 } });
    for (let i = 0; i <= 7; i++) {
      const tick = i * 6;
      dvr.push(tick * SIM_DT * 1000, [{ tick, id: 's1', p: { x: i, y: 2, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } }]);
    }
    const adapter = fakeAdapter();

    // At LIVE: no rewound shapes drawn; the decorative/live view is shown.
    renderDvrFrame(adapter, dvr);
    expect(adapter.meshes.size).toBe(0);
    expect(adapter.decorative).toBe(true);

    // SCRUBBED: the render path is fed dvr.poses() — namespaced replay ids drawn,
    // decorative orb hidden (the §7.19 "orbit the frozen throw" consumption).
    dvr.scrubTo(3 * 6 * SIM_DT * 1000, 999_999);
    renderDvrFrame(adapter, dvr);
    expect(adapter.meshes.size).toBeGreaterThan(0);
    for (const id of adapter.ids()) expect(id.startsWith('replay::')).toBe(true);
    expect(adapter.decorative).toBe(false);
    // The drawn pose equals the DVR's rewound pose for that id (the real feed).
    const poses = dvr.poses();
    expect(poses.length).toBe(adapter.meshes.size);
    for (const { id, pose } of poses) expect(adapter.meshes.get(id)).toEqual(pose);

    // JUMP TO LIVE: the rewound shapes are removed and the decorative view resumes.
    dvr.jumpToLive();
    renderDvrFrame(adapter, dvr);
    expect(adapter.meshes.size).toBe(0);
    expect(adapter.decorative).toBe(true);
  });

  it('with no DVR the render path is inert (decorative only)', () => {
    const adapter = fakeAdapter();
    renderDvrFrame(adapter, null);
    expect(adapter.meshes.size).toBe(0);
    expect(adapter.decorative).toBe(true);
  });
});

describe('C30 Pocket DVR viewer — DOM scrub UI', () => {
  function feedArc(dvr: PocketDvr): void {
    // A decimated free-flight arc + its release seed (so speed can hit 0.25×).
    dvr.setShapeMeta('s1', 'icosahedron', 1);
    dvr.onRelease({ tick: 0, id: 's1', p: { x: 0, y: 2, z: 0 }, v: { x: 6, y: 5, z: 0 } });
    for (let i = 0; i <= 7; i++) {
      const tick = i * 6;
      dvr.push(tick * SIM_DT * 1000, [
        { tick, id: 's1', p: { x: i, y: 2, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } },
      ]);
    }
  }

  it('renders the scrub bar + hidden badge at live, then the REWOUND badge when scrubbed', () => {
    const dvr = new PocketDvr('wisp');
    feedArc(dvr);
    const ui = mountDvrUi(root, dvr);

    ui.update(999_999);
    expect(q('[data-role="dvr-scrub"]')).not.toBeNull();
    // At live the badge is hidden and speed is 1×.
    expect((q('[data-role="dvr-badge"]') as HTMLElement).hidden).toBe(true);
    expect(q('[data-role="dvr-speed"]')!.textContent).toBe('1×');

    // Drag the scrub slider left into the arc → REWOUND badge + 0.25× (resim segment).
    const scrub = q('[data-role="dvr-scrub"]') as HTMLInputElement;
    scrub.value = '400';
    scrub.dispatchEvent(new Event('input'));
    ui.update(999_999);
    expect(dvr.isLive).toBe(false);
    const badge = q('[data-role="dvr-badge"]') as HTMLElement;
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toMatch(/^REWOUND \/\/ T-\d+\.\d+s$/);
    expect(q('[data-role="dvr-speed"]')!.textContent).toBe('0.25×');

    ui.dispose();
  });

  it('JUMP TO LIVE drains forward (no server round-trip) and pins the slider right', () => {
    const dvr = new PocketDvr('wisp');
    feedArc(dvr);
    const ui = mountDvrUi(root, dvr);
    const scrub = q('[data-role="dvr-scrub"]') as HTMLInputElement;
    scrub.value = '200';
    scrub.dispatchEvent(new Event('input'));
    expect(dvr.isLive).toBe(false);

    (q('[data-role="dvr-live"]') as HTMLButtonElement).click();
    ui.update(999_999);
    expect(dvr.isLive).toBe(true);
    expect(dvr.serverRoundTrips).toBe(0);
    expect(scrub.value).toBe('1000');
    ui.dispose();
  });

  it('shades a §5.3 background-tab gap on the track', () => {
    const dvr = new PocketDvr('wisp');
    dvr.push(0, [{ tick: 0, id: 's1', p: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } }]);
    dvr.push(200, [{ tick: 6, id: 's1', p: { x: 1, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } }]);
    dvr.push(5_000, [{ tick: 12, id: 's1', p: { x: 2, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } }]);
    const ui = mountDvrUi(root, dvr);
    ui.update(999_999);
    expect(root.querySelectorAll('.dvr-gap').length).toBe(1);
    ui.dispose();
  });
});

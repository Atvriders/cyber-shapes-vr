/**
 * wispAim.dom.test.ts — Task C14 (F4) phone aim + gyro gating + over-cap spectate.
 * jsdom (the gyro-permission flow + spectate page touch the DOM). Time is faked.
 *
 * Aim model (spec §7.4):
 *   • touch-drag with an AUTO-AIM cone is the DEFAULT (no permission needed);
 *   • gyro is progressive enhancement — camera-RELATIVE ray, double-tap recenter,
 *     motion mode gated on receiving an actual `deviceorientation` event within
 *     ~1 s of the permission grant (in-app QR browsers fall back silently);
 *   • `DeviceOrientationEvent.requestPermission()` is called INSIDE the tap
 *     handler (iOS requires a user-gesture-scoped call).
 * Over-cap: a wisp-over-cap downgrade renders a spectate page with queue position.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  autoAim,
  cameraRelativeAim,
  GyroGate,
  GYRO_GRANT_WINDOW_MS,
  renderSpectatePage,
} from '../src/funnel/wisp3d.ts';

describe('autoAim — touch-drag default with auto-aim cone', () => {
  it('snaps a near-cone drag onto the nearest target inside the cone', () => {
    const targets = [
      { id: 'a', dir: { x: 0, y: 0, z: -1 } },
      { id: 'b', dir: { x: 1, y: 0, z: 0 } },
    ];
    // A drag ray a few degrees off target "a" snaps to it.
    const ray = { x: 0.08, y: 0, z: -1 };
    const aimed = autoAim(ray, targets, Math.cos(Math.PI / 6));
    expect(aimed?.id).toBe('a');
  });

  it('returns null when nothing is inside the auto-aim cone (free aim)', () => {
    const targets = [{ id: 'a', dir: { x: 0, y: 0, z: -1 } }];
    const ray = { x: 0, y: 1, z: 0 }; // straight up — nothing near
    expect(autoAim(ray, targets, Math.cos(Math.PI / 12))).toBeNull();
  });
});

describe('cameraRelativeAim — gyro is a camera-RELATIVE ray (never absolute heading)', () => {
  it('subtracts the recenter reference so double-tap recenter re-zeros forward', () => {
    // Facing 30° right of the recenter reference → the relative ray points 30° right.
    const ref = { yaw: 1.0, pitch: 0 };
    const now = { yaw: 1.0 + Math.PI / 6, pitch: 0 };
    const ray = cameraRelativeAim(now, ref);
    // Relative yaw of +30° → x>0, z<0 (still mostly forward, tilted right).
    expect(ray.x).toBeGreaterThan(0);
    expect(ray.z).toBeLessThan(0);
    // At the reference exactly, the ray is straight forward (−Z).
    const fwd = cameraRelativeAim(ref, ref);
    expect(fwd.x).toBeCloseTo(0, 6);
    expect(fwd.z).toBeCloseTo(-1, 6);
  });
});

describe('GyroGate — event-gated ≤ 1 s after the permission grant', () => {
  it('activates ONLY if a deviceorientation event arrives within the grant window', () => {
    let now = 0;
    const gate = new GyroGate(() => now);
    gate.onGranted(); // permission granted at t=0
    now = 500; // event arrives at 500 ms (< 1 s)
    gate.onEvent();
    expect(gate.active).toBe(true);
  });

  it('stays inactive (silent fallback) if no event arrives within the window', () => {
    let now = 0;
    const gate = new GyroGate(() => now);
    gate.onGranted();
    now = GYRO_GRANT_WINDOW_MS + 1; // window elapsed, no event yet
    gate.onEvent(); // late event — too late
    expect(gate.active).toBe(false);
  });

  it('is inactive before any grant (touch-drag remains the default)', () => {
    const gate = new GyroGate(() => 0);
    gate.onEvent();
    expect(gate.active).toBe(false);
  });
});

describe('requestPermission is invoked inside the tap handler (iOS gesture rule)', () => {
  it('calls DeviceOrientationEvent.requestPermission() synchronously in the tap', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    // Simulate the tap handler body from wisp3d: it must call requestPermission
    // itself (not defer it), so iOS accepts the user-gesture context.
    const { requestGyroPermission } = await import('../src/funnel/wisp3d.ts');
    const deviceOrientationEvent = { requestPermission } as unknown as {
      requestPermission: () => Promise<'granted' | 'denied'>;
    };
    const p = requestGyroPermission(deviceOrientationEvent);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    await expect(p).resolves.toBe('granted');
  });

  it('resolves "unsupported" when there is no DeviceOrientationEvent.requestPermission (Android)', async () => {
    const { requestGyroPermission } = await import('../src/funnel/wisp3d.ts');
    // Android Chrome: no requestPermission — gyro is available without a prompt.
    await expect(requestGyroPermission({} as unknown as never)).resolves.toBe('unsupported');
  });
});

describe('over-cap → spectate page with queue position', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
  });

  it('renders a spectate page showing the queue position when over the wisp cap', () => {
    renderSpectatePage(root, { queuePosition: 3, callsign: 'VOLT-17' });
    const text = root.textContent ?? '';
    expect(root.querySelector('[data-role="spectate"]')).not.toBeNull();
    expect(text).toContain('3'); // queue position surfaced
    expect(text).toContain('VOLT-17');
  });
});

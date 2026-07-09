/**
 * slingshot.dom.test.ts — the C16 phone Meteor Siege slingshot (spec §7.6). jsdom
 * (matched by the `.dom.test.ts` glob). Covers the DOM-only surface: the drag→aim
 * mapping, the met-launch message helper (power clamped to [0,1]), the recharge
 * cooldown (1 per 3 s), the send wiring emitting a `met-launch`, and the import-
 * graph guarantee that the slingshot never pulls `three` (crowd < 100 KB).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  makeMetLaunchMessage,
  dragToLaunch,
  mountSlingshot,
  SLINGSHOT_COOLDOWN_MS,
} from '../src/funnel/slingshot.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('C16 slingshot — helpers', () => {
  it('makeMetLaunchMessage clamps power to [0, 1] and carries the aim + color', () => {
    const over = makeMetLaunchMessage({ x: 1, y: 0.3, z: 0 }, 5, 3); // hostile power
    expect(over.t).toBe('met-launch');
    expect(over.power).toBe(1); // clamped
    expect(over.colorIndex).toBe(3);
    const under = makeMetLaunchMessage({ x: 0, y: 0.3, z: 1 }, -2, 0);
    expect(under.power).toBe(0); // clamped up from negative
  });

  it('dragToLaunch inverts the pull (fires opposite the drag) and normalises power', () => {
    // A full-length pull down-right → aim up-left, power ~1.
    const { aim, power } = dragToLaunch(140, 140, 140);
    expect(power).toBeCloseTo(1, 2);
    expect(aim.x).toBeLessThan(0); // inverted x
    expect(aim.z).toBeLessThan(0); // inverted z
    // A short pull → small power.
    expect(dragToLaunch(14, 0, 140).power).toBeCloseTo(0.1, 2);
  });
});

describe('C16 slingshot — mount + send', () => {
  it('sends a met-launch on a drag-release past the cooldown, then RATE-LIMITS the next', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const sent: string[] = [];
    let now = 0;
    const ws = { send: (d: string) => sent.push(d) };
    mountSlingshot(root, ws, { colorIndex: 4, now: () => now });
    const canvas = root.querySelector('[data-role="slingshot-canvas"]') as HTMLCanvasElement;
    expect(canvas).toBeTruthy();

    const drag = (): void => {
      // Pull back far enough to exceed the min-pull threshold.
      canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 160, clientY: 160 }));
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 60, clientY: 260 }));
      canvas.dispatchEvent(new MouseEvent('pointerup', { clientX: 60, clientY: 260 }));
    };

    drag();
    expect(sent.length).toBe(1);
    const msg = JSON.parse(sent[0]);
    expect(msg.t).toBe('met-launch');
    expect(msg.colorIndex).toBe(4);

    // A second drag before the cooldown elapses is rate-limited (no send).
    drag();
    expect(sent.length).toBe(1);

    // After the recharge window, the next drag fires again.
    now += SLINGSHOT_COOLDOWN_MS + 1;
    drag();
    expect(sent.length).toBe(2);
  });

  it('the slingshot module never statically imports `three` (crowd chunk stays < 100 KB)', () => {
    const src = readFileSync(resolve(HERE, '../src/funnel/slingshot.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"]three['"]/);
    expect(src).not.toMatch(/import\(['"]three['"]\)/);
  });
});

# Phase A — Upgrade & Stabilize — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the static single-player `cyber-shapes-vr` into a modern, TypeScript, tested, bug-fixed, Quest-2-performant single-player base with a clean shape-lifecycle API — ready for Phase B multiplayer.

**Architecture:** Convert to an npm-workspaces monorepo (`packages/shared`, `packages/client`, `packages/server` skeleton). Migrate the client to TypeScript. Extract pure logic + constants into `packages/shared` with Vitest unit tests. Fix the latent bugs. Bump Three.js + Vite. Apply Quest-2 GPU perf work. Refactor shape create/mutate/remove behind one `ShapeStore` API so Phase B has clean network hook-points.

**Tech Stack:** TypeScript 5, Vite (latest 5.x→6/7), Three.js (r0.168 → latest), Vitest, ESLint + Prettier, npm workspaces, jsdom for DOM-touching tests.

## Global Constraints

- **NO incremental commits.** Every task ends at "verify green + `git add`". The single commit happens only at the very end of the whole project (Phase A + Phase B + audit), after full verification. (Owner rule.)
- **TypeScript everywhere** — new/modified modules are `.ts`; the world/shape/constants contracts are strongly typed.
- **All repos/packages public.** No private packages.
- **Target platform:** Meta Quest 2 browser (Chromium) + desktop Chromium. Keep WebXR working at every step.
- **Cosmetic vs. shared state:** `world.shapes[]` is the only shared/game state. Stars, dust, HUD, bloom, particles, audio stay per-client. Do not entangle them.
- **No behavior regressions** to the VR grab/throw/spawn/resize/recolor/render-mode loop unless a task explicitly fixes it.
- **Keep it runnable:** `npm run -w packages/client dev` must serve after every task; `npm test` must pass after every task that adds tests.

## File Structure (target after Phase A)

```
package.json                      # workspace root (private, workspaces: packages/*)
tsconfig.base.json                # shared TS config
.eslintrc.cjs / .prettierrc       # lint/format
vitest.config.ts                  # test runner (root)
packages/
  shared/
    package.json
    src/
      constants.ts                # SHAPE_TYPES, CYBER_COLORS, physics + world constants
      shapeMath.ts                # pure: cycleColorIndex, cycleRenderMode, clampScale, restYFor(type,scale)
      physicsCore.ts              # pure Three-free integrator (seeded in A; owned by Phase B)
      index.ts
    test/ *.test.ts
  client/
    package.json
    index.html
    vite.config.ts                # host, port 3020, dev https
    public/
    src/
      main.ts                     # entry + integration hub + game loop
      world.ts                    # World type + ShapeStore (create/mutate/remove API) + events
      shapes.ts                   # geometry/material build, per-shape render update
      physics.ts                  # thin adapter: applies physicsCore over world.shapes (Three objects)
      controllers.ts              # XR input -> ShapeStore intents; desktop interaction path
      environment.ts              # grid/stars/dust/HUD (updateHudShapeCount wired)
      effects.ts                  # postprocessing + particle pool (size via ShaderMaterial)
      audio.ts                    # Web Audio SFX, 48kHz context
      types.ts                    # ShapeType, RenderMode, Shape, World interfaces
  server/
    package.json                  # skeleton only in Phase A (empty express/ws stub, not wired)
    src/index.ts                  # placeholder that logs "server skeleton"; real in Phase B
docs/superpowers/...
Dockerfile / docker-compose.yml / nginx.conf   # unchanged in A; revisited in Phase B infra
```

---

### Task A0: Workspace + tooling scaffold

**Files:**

- Create: `package.json` (root), `tsconfig.base.json`, `.eslintrc.cjs`, `.prettierrc`, `vitest.config.ts`, `.gitignore` (update)
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Create: `packages/server/package.json`, `packages/server/src/index.ts` (skeleton)

**Interfaces:**

- Produces: workspace scripts `npm test` (vitest), `npm run lint`, `npm run build` (per-package). `packages/shared` importable as `@cyber-shapes/shared`.

- [ ] **Step 1:** Create root `package.json` with `"private": true`, `"workspaces": ["packages/*"]`, devDeps `typescript@^5`, `vitest@^2`, `eslint@^9`, `@typescript-eslint/*`, `prettier@^3`, `jsdom`. Scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, `"lint": "eslint ."`, `"format": "prettier -w ."`, `"typecheck": "tsc -b"`.
- [ ] **Step 2:** Create `tsconfig.base.json` (`strict: true`, `moduleResolution: "bundler"`, `target: "ES2022"`, `lib: ["ES2022","DOM","DOM.Iterable"]`, `types: []`). Per-package tsconfigs extend it.
- [ ] **Step 3:** Create `packages/shared/package.json` (`"name": "@cyber-shapes/shared"`, `"type": "module"`, `main`/`exports` → `src/index.ts`). Add a trivial `src/index.ts` exporting `export const SHARED_OK = true`.
- [ ] **Step 4:** Create `packages/server/package.json` + `src/index.ts` skeleton: `console.log('server skeleton — implemented in Phase B')`. Not wired to anything.
- [ ] **Step 5:** Add `vitest.config.ts` with `environment: 'node'` default and a `jsdom` override pattern for `*.dom.test.ts`.
- [ ] **Step 6: Verify** `npm install` succeeds and `npm test` runs (0 tests OK). Run `npm run typecheck`. Fix errors.
- [ ] **Step 7: Stage** `git add` new files. (No commit.)

---

### Task A1: Move client into the workspace (no behavior change)

**Files:**

- Move: `index.html` → `packages/client/index.html`; `src/*` → `packages/client/src/*` (still `.js` for now); `vite.config.js` → `packages/client/vite.config.ts`
- Create: `packages/client/package.json`, `packages/client/tsconfig.json`

**Interfaces:**

- Produces: `npm run -w packages/client dev` serves the app on `https://localhost:3020` (dev https added in A5-tooling below; plain https here via `@vitejs/plugin-basic-ssl`).

- [ ] **Step 1:** `git mv` the files into `packages/client/`. Keep `src` filenames `.js` initially.
- [ ] **Step 2:** Create `packages/client/package.json` (`"name": "@cyber-shapes/client"`, deps `three@^0.168` for now, `devDeps` `vite`, `@vitejs/plugin-basic-ssl`). Scripts: `dev`, `build`, `preview`.
- [ ] **Step 3:** Rewrite `vite.config.ts`: `server.host=true`, `server.port=3020`, add `basicSsl()` plugin (dev HTTPS — required by WebXR), `build.outDir='dist'`.
- [ ] **Step 4: Verify** `npm run -w packages/client build` succeeds and `dev` serves. Manually confirm the app still loads (desktop orbit view renders shapes).
- [ ] **Step 5: Stage.**

---

### Task A2: TypeScript contracts — `types.ts` + shared constants

**Files:**

- Create: `packages/client/src/types.ts`
- Create: `packages/shared/src/constants.ts`; update `packages/shared/src/index.ts`
- Test: `packages/shared/test/constants.test.ts`

**Interfaces:**

- Produces:
  - `type ShapeType = 'cube'|'sphere'|'icosahedron'|'torus'|'torusKnot'|'octahedron'|'dodecahedron'|'cylinder'|'cone'|'tetrahedron'`
  - `type RenderMode = 'both'|'solid'|'wireframe'`
  - `SHAPE_TYPES: readonly ShapeType[]` (10), `CYBER_COLORS: readonly number[]` (7 hex), `RENDER_MODES: readonly RenderMode[]`
  - physics/world consts: `GRAVITY`, `BOUNCE`, `FRICTION`, `REST_THRESHOLD`, `REMOVE_DISTANCE`, `MAX_SHAPES`, `MAX_LIGHTS`
  - `interface Shape { id: string; type: ShapeType; colorIndex: number; renderMode: RenderMode; scale: number; grabbedBy: string|null; grounded: boolean; bobPhase: number; rotSpeed: {x:number;y:number;z:number}; velocity: {x:number;y:number;z:number}; /* client-only render handles added in shapes.ts */ }`
  - `interface World { shapes: Shape[]; maxShapes: number }`

- [ ] **Step 1: Write failing test** `constants.test.ts`: assert `SHAPE_TYPES.length===10`, `CYBER_COLORS.length===7`, each color is an int 0..0xffffff, `MAX_SHAPES===40`.
- [ ] **Step 2:** Run `npm test` → FAIL (module not found).
- [ ] **Step 3:** Implement `constants.ts` (copy the exact values from current `shapes.js`/`physics.js`) and re-export from `index.ts`. Create `types.ts` with the interfaces above (note `grabbed:boolean` becomes `grabbedBy:string|null`; local means `grabbedBy === LOCAL_ID`).
- [ ] **Step 4:** Run `npm test` → PASS. `npm run typecheck` clean.
- [ ] **Step 5: Stage.**

---

### Task A3: Pure shape math in `shared` (TDD)

**Files:**

- Create: `packages/shared/src/shapeMath.ts`; export from `index.ts`
- Test: `packages/shared/test/shapeMath.test.ts`

**Interfaces:**

- Produces:
  - `cycleColorIndex(i: number): number` → `(i+1) % CYBER_COLORS.length`
  - `cycleRenderMode(m: RenderMode): RenderMode` → both→solid→wireframe→both
  - `clampScale(s: number): number` → clamp to `[0.2, 3]`
  - `restYFor(type: ShapeType, scale: number): number` → per-shape rest height using each primitive's half-height (fixes the cube-only `0.15*scale` bug). Table: cube/octa/tetra/dodeca/icosa use bounding-sphere radius; sphere = r; cylinder/cone = height/2; torus/torusKnot = tube+radius. Encode concrete half-extents matching the geometry params in `shapes.js`.

- [ ] **Step 1: Write failing tests:** `clampScale(5)===3`, `clampScale(0.1)===0.2`, `cycleRenderMode('both')==='solid'`, `cycleRenderMode('wireframe')==='both'`, `cycleColorIndex(6)===0`, `restYFor('sphere',2) > 0` and `restYFor('cube',1)` equals the cube half-height constant.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `shapeMath.ts`. Derive `restYFor` half-extents from the actual geometry dimensions defined in `shapes.js` (read them; do not guess).
- [ ] **Step 4:** Run → PASS. Typecheck clean.
- [ ] **Step 5: Stage.**

---

### Task A4: Migrate `audio.ts` to TS + 48 kHz context

**Files:**

- Modify/rename: `packages/client/src/audio.js` → `audio.ts`
- Test: `packages/client/test/audio.dom.test.ts` (jsdom + mocked AudioContext)

**Interfaces:**

- Produces: `initAudio(): AudioApi` where `AudioApi = { ctx: AudioContext; resume(): Promise<void>; playSpawn(): void; playGrab(): void; playRelease(): void; playImpact(v?: number): void }`. **`ctx` is created with `{ sampleRate: 48000 }`** (voice needs 48k; shared context avoids a second one).

- [ ] **Step 1: Write failing test:** with a mocked `AudioContext`, assert `initAudio().ctx` was constructed with `sampleRate:48000` and that `playImpact` is a no-op-safe function when ctx is suspended.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Port `audio.js` to TS; construct context as `new AudioContext({ sampleRate: 48000 })`; guard all `play*` against `ctx.state !== 'running'`.
- [ ] **Step 4:** Run → PASS. Typecheck clean. Manually confirm SFX still fire on desktop.
- [ ] **Step 5: Stage.**

---

### Task A5: `ShapeStore` — the single lifecycle API (TDD, the keystone refactor)

**Files:**

- Create: `packages/client/src/world.ts`
- Modify: `packages/client/src/shapes.js` → `shapes.ts` (build geometry/material + per-frame render update only; NO id counter, NO array ownership)
- Test: `packages/client/test/world.test.ts`

**Interfaces:**

- Produces `class ShapeStore`:
  - `constructor(scene: THREE.Scene, opts: { maxShapes: number; idFactory: () => string; onEvent?: (e: ShapeEvent) => void })`
  - `spawn(init: Partial<Shape> & { type: ShapeType }): Shape` — assigns id via `idFactory` (local monotonic in A; server-assigned in B), enforces `maxShapes` (removes oldest), builds render objects, seeds `bobPhase`/`rotSpeed` if absent, emits `{kind:'spawn', shape}`.
  - `remove(id: string): void` — disposes render objects, splices, emits `{kind:'despawn', id}`. **Single deletion path** (physics + out-of-bounds call this).
  - `setColor(id, colorIndex)`, `setRenderMode(id, mode)`, `setScale(id, scale)`, `setGrab(id, peerId|null)` — each mutate + emit a typed event.
  - `get shapes(): Shape[]`, `get(id): Shape|undefined`
  - `type ShapeEvent = {kind:'spawn';shape:Shape} | {kind:'despawn';id:string} | {kind:'color';id:string;colorIndex:number} | {kind:'render';id:string;mode:RenderMode} | {kind:'scale';id:string;scale:number} | {kind:'grab';id:string;peerId:string|null}`
- `shapes.ts` produces: `buildShapeObject(shape: Shape): { group, solidMesh, wireMesh, light? }`, `updateShapeRender(shape, delta)` (autonomous rotation/bob + mesh visibility from renderMode), `applyColor(shape)`.

- [ ] **Step 1: Write failing tests** (use a stubbed `scene` with `add`/`remove` spies and a fake idFactory): spawning past `maxShapes` removes the oldest and keeps length at max; `remove` emits exactly one `despawn`; `setColor` clamps/cycles and emits `color`; `setGrab` sets `grabbedBy` and emits `grab`; ids come from `idFactory`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `ShapeStore` + port `shapes.ts` render helpers. Move the "first N shapes get a light" rule behind `MAX_LIGHTS` counting live lights (not array index). Emit events through `onEvent`.
- [ ] **Step 4:** Run → PASS. Typecheck clean.
- [ ] **Step 5: Stage.**

---

### Task A6: `physics.ts` adapter over pure `physicsCore` (TDD)

**Files:**

- Create: `packages/shared/src/physicsCore.ts`; export from `index.ts`
- Modify: `packages/client/src/physics.js` → `physics.ts`
- Test: `packages/shared/test/physicsCore.test.ts`

**Interfaces:**

- Produces (pure, Three-free — the seed of Phase B's server physics):
  - `interface PhysicsBody { position:{x,y,z}; velocity:{x,y,z}; scale:number; type:ShapeType; grabbedBy:string|null; grounded:boolean }`
  - `stepBody(body: PhysicsBody, dt: number): { impact:boolean; impactSpeed:number; removed:boolean }` — gravity, floor at `restYFor(type,scale)`, bounce, friction, rest, `removed` when `|pos|>REMOVE_DISTANCE`. Skips integration when `grabbedBy!==null`.
- `physics.ts` produces `updatePhysics(dt, store: ShapeStore, onImpact)` — for each shape: sync `body` from the Three group, `stepBody`, write back to `group.position`, fire `onImpact`, and call `store.remove(id)` on `removed` (single deletion path → emits despawn).

- [ ] **Step 1: Write failing tests** on `stepBody`: a body above floor gains downward velocity and falls; a fast downward body at floor bounces (velocity.y flips, magnitude ×BOUNCE) and reports `impact:true`; a slow body settles (`grounded:true`, velocity ~0); a body beyond REMOVE_DISTANCE reports `removed:true`; a `grabbedBy` body does not move.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `physicsCore.ts` (delta-scaled friction/damping — fix the per-frame-constant bug: `v *= FRICTION ** (dt*60)` or equivalent). Rewrite `physics.ts` as the adapter.
- [ ] **Step 4:** Run → PASS. Typecheck clean.
- [ ] **Step 5: Stage.**

---

### Task A7: Fix latent bugs (effects resize, particle size, HUD counter)

**Files:**

- Modify: `packages/client/src/effects.js` → `effects.ts`, `environment.js` → `environment.ts`, `main.js` (touch)
- Test: `packages/client/test/effects.test.ts` (pure parts only)

**Interfaces:**

- Produces: `initEffects(renderer,scene,camera): { composer; isVR(): boolean; setSize(w,h): void; renderFrame(): void }` (adds the missing `setSize`). Particle system uses a `ShaderMaterial` with a per-vertex `size` attribute (so the size-fade actually renders). `environment.ts` exports `updateHudShapeCount(n)` and is called on spawn/despawn.

- [ ] **Step 1: Write failing test** for the particle `ShaderMaterial` builder: returns a material whose vertex shader references an `attribute float size` and `gl_PointSize`. (Pure builder function extracted for testability.)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: (a) `effects` exposes `setSize` and `main.ts` `onResize` calls it; (b) particle `ShaderMaterial` with per-vertex size; (c) wire `updateHudShapeCount(store.shapes.length)` on ShapeStore spawn/despawn events.
- [ ] **Step 4:** Run → PASS. Manually confirm resize no longer breaks bloom and HUD counter updates.
- [ ] **Step 5: Stage.**

---

### Task A8: `main.ts` migration + desktop interaction path

**Files:**

- Modify: `packages/client/src/main.js` → `main.ts`, `controllers.js` → `controllers.ts`
- Test: `packages/client/test/controllers.test.ts` (pure button-edge + intent mapping)

**Interfaces:**

- Produces: `initControllers(renderer, store, audio): ControllerApi`; `updateControllers(frame, dt, store, callbacks)`. Emits intents through `ShapeStore` methods (not direct mutation). Adds `cycleColor`→`store.setColor`, `cycleRenderMode`→`store.setRenderMode`, spawn→`store.spawn`, grab/release→`store.setGrab`. **Desktop interaction:** when `!frame` (no XR), enable a raycaster-from-mouse path: click to spawn, click-drag to grab/throw, keys for color/mode — so desktop is testable and not dead.
- `main.ts` wires the `ShapeStore` with a local `idFactory` (`() => 'local:' + n++`), drains no network (single-player), runs the loop: inbound(none) → physics → render update → controllers → effects → environment → render.

- [ ] **Step 1: Write failing test** for a pure `buttonEdge(prev,curr)` helper and an `intentForButtons(state)` mapper (grip→grab, trigger→spawn, A/X→color, B/Y→mode). Assert edges fire once per press.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Port `controllers.ts` + `main.ts` to TS; route all mutations through `ShapeStore`; add the desktop raycaster path.
- [ ] **Step 4:** Run → PASS. Manually confirm VR path unaffected (grab/throw/spawn/resize/recolor/mode) AND desktop now interactive.
- [ ] **Step 5: Stage.**

---

### Task A9: Three.js + Vite bump

**Files:**

- Modify: `packages/client/package.json` (three → latest, vite → latest), `effects.ts` (postprocessing imports), any addon import paths.

**Interfaces:**

- Consumes: everything above. Produces: same public behavior on the new Three version.

- [ ] **Step 1:** Bump `three` to latest and `vite` to latest in `packages/client`. `npm install`.
- [ ] **Step 2:** Run `npm run typecheck` + `npm run -w packages/client build`. Fix breakages — expected hot spots: `three/addons` postprocessing (`EffectComposer`/`UnrealBloomPass`/`OutputPass`), `VRButton`, `XRControllerModelFactory`, `OrbitControls` import paths; any removed API.
- [ ] **Step 3:** Run `npm test` → all green.
- [ ] **Step 4:** Manually confirm the app builds and runs (desktop bloom + VR path) on the new version.
- [ ] **Step 5: Stage.**

---

### Task A10: Quest 2 GPU perf pass

**Files:**

- Modify: `packages/client/src/shapes.ts`, `main.ts`, `effects.ts`

**Interfaces:**

- Produces: capped/cheaper lighting, no double-transparent overdraw, cached geometry, foveation + DPR clamp, and a WebXR-compatible glow so the neon aesthetic exists in-headset.

- [ ] **Step 1:** Geometry cache: one shared `BufferGeometry` per `ShapeType` (Map), reused by all instances (dispose only when cache cleared).
- [ ] **Step 2:** Lighting: cap dynamic `PointLight`s hard (`MAX_LIGHTS`, e.g. 6) OR replace per-shape lights with emissive-only materials; keep the neon look via emissive intensity.
- [ ] **Step 3:** Overdraw: make solid material opaque (drop `opacity:0.6`) or drop the wireframe overlay in `solid` mode; keep wireframe mode as the only transparent path.
- [ ] **Step 4:** `renderer.xr.setFoveation(1)`; clamp desktop DPR `Math.min(devicePixelRatio, 2)`; consider `renderer.xr.setFramebufferScaleFactor`.
- [ ] **Step 5:** In-headset glow: emissive materials (bloom is bypassed in stereo) tuned so wireframes/edges read as neon without the composer.
- [ ] **Step 6: Verify** build + tests green; manually confirm visual parity/perf on desktop. (Quest FPS is owner-verified.)
- [ ] **Step 7: Stage.**

---

### Task A11: ESLint/Prettier clean + Phase A gate

**Files:** repo-wide.

- [ ] **Step 1:** `npm run lint` → fix all errors; `npm run format`.
- [ ] **Step 2:** `npm run typecheck` → clean. `npm test` → all green. `npm run -w packages/client build` → succeeds.
- [ ] **Step 3:** Manual smoke: desktop interactive + VR grab/throw/spawn/resize/recolor/mode all work; HUD counter updates; resize doesn't break bloom.
- [ ] **Step 4:** `git add -A` (stage). **Do NOT commit** — Phase B continues on this working tree; single commit at the very end.
- [ ] **Step 5:** Proceed to author Plan 2 (Phase B) against the now-real `ShapeStore`/`physicsCore`/event API.

---

## Self-Review (against the spec)

- **Spec §6.1 tooling/TS/CI** → A0, A11 (CI gate config added in Phase B infra task; lint/test/typecheck runnable now). ✔
- **§6.2 TLS dev** → A1 (basic-ssl). Prod TLS is Phase B infra. ✔
- **§6.3 dep bumps** → A9. ✔
- **§6.4 bug fixes** → restY A3/A6, deletion unification A5/A6, HUD A7, composer resize A7, particle size A7, desktop interaction A8, delta-scaled damping A6. ✔ (all 7)
- **§6.5 perf** → A10. ✔
- **§6.6 lifecycle API refactor** → A5 (ShapeStore) + A8 (route intents through it). ✔
- **Type consistency:** `Shape.grabbedBy:string|null` used consistently (types.ts A2 → ShapeStore A5 → physicsCore A6 → controllers A8). `restYFor` defined A3, consumed A6. `ShapeEvent` defined A5, consumed A7 (HUD) and A8. `AudioApi` A4 consumed A8. ✔
- **Placeholder scan:** server `src/index.ts` is an intentional skeleton (documented), not a plan placeholder. No TBD/TODO steps. ✔
- **CI note:** the CI lint/test gate and prod TLS/reverse-proxy land in Phase B's infra task since they change deploy topology; Phase A keeps them locally runnable. (Explicitly deferred, not forgotten.)

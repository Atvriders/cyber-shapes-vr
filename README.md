# Cyber Shapes VR

**A cyberpunk spatial playground for Meta Quest 2 — grab, throw, and play with neon geometric shapes in VR.**

WebXR application built with Three.js. Open in the Quest 2 browser, hit "Enter VR", and start playing with glowing shapes in a cyberpunk environment.

## Features

- **10 geometric shape types** — cubes, spheres, icosahedrons, torus, torus knots, octahedrons, dodecahedrons, cylinders, cones, tetrahedrons
- **Grab and throw** — grip button picks up nearest shape, release to throw with physics
- **Spawn shapes** — trigger button creates new random shapes at your controller
- **Resize** — thumbstick scales held shapes up and down
- **Cycle colors** — A/X button changes shape color through 7 cyberpunk neons
- **Cycle render mode** — B/Y button toggles wireframe / solid / both
- **Physics** — shapes fall with floaty gravity, bounce off the floor
- **Cyberpunk environment** — infinite neon grid floor, starfield, floating dust particles, purple fog, holographic HUD panels
- **Bloom glow** — neon wireframes and emissive materials glow (desktop mode)
- **Procedural audio** — synth sounds for spawn, grab, release, impact
- **Desktop preview** — orbit controls for non-VR testing

## Controls (Quest 2)

| Button | Action |
|--------|--------|
| Grip | Grab / release shape |
| Trigger | Spawn new random shape |
| Thumbstick Y | Resize held shape |
| A / X | Cycle color of held shape |
| B / Y | Toggle wireframe / solid / both |

## Quick Start

```bash
git clone https://github.com/Atvriders/cyber-shapes-vr.git
cd cyber-shapes-vr
npm install
npm run dev
```

Open `https://localhost:3020` on your Quest 2 browser (or any WebXR-capable browser).

## Deploy

```bash
npm run build
# Serve dist/ with any HTTPS static server
```

WebXR requires HTTPS. For local Quest 2 testing, Vite's `--host` flag exposes the server on your LAN.

## Tech Stack

- Three.js 0.168 (WebGL + WebXR)
- Vite 5 (build + dev server)
- Web Audio API (procedural synth sounds)
- No frameworks — pure vanilla JS for VR performance

## Performance

Optimized for Quest 2's mobile GPU:
- Low-poly geometries (12-24 segments)
- Max 40 shapes (auto-removes oldest)
- Point lights capped at 20
- Bloom only in desktop mode (direct render in VR)
- Additive blending particles (no alpha sorting)
- No shadow maps

---

*Built with [Claude Code](https://claude.ai/claude-code)*

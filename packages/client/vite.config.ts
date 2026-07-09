import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Multi-entry build (spec §5.7 / §5.8 — the code-split phone funnel).
//
// Entries:
//   main            — the headset/desktop client (index.html at package root).
//   funnel          — the phone router page (src/funnel/index.html); it
//                     dynamically imports one of the entry chunks below.
//   ballot / crowd  — DOM-only crowd-tier entries; MUST NOT pull `three`
//                     (asserted by tools/check-bundle-size.mjs, < 100 KB gz).
//   wisp            — join-first wisp entry; `three` is isolated into an async
//                     chunk via the dynamic import('./wisp3d.js') boundary, so
//                     the wisp ENTRY chunk stays < 300 KB gz initial.
//   exit            — the exit/souvenir screen (DOM-only).
//
// Because ballot/crowd/exit never statically import `three`, Rollup keeps three
// out of their chunks automatically; the wisp entry only reaches three through a
// dynamic import, so three lands in its own lazily-loaded chunk. The size gate
// (npm run size) is the enforcement.
// ---------------------------------------------------------------------------

export default defineConfig({
  plugins: [basicSsl()],
  resolve: {
    alias: {
      // Resolve shared package to its TypeScript source so vite compiles it
      // directly into the client bundle — no packages/shared/dist prebuild needed.
      '@cyber-shapes/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 3020,
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        // The headset/desktop client.
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        // The phone funnel router page. Its dynamic imports produce the per-
        // entry chunks (ballot/crowd/wisp/exit) named below.
        funnel: fileURLToPath(new URL('./src/funnel/index.html', import.meta.url)),
        // The F1 Neon Director big-screen stage (C9, `?mode=stage`). Its 3D
        // render governor is dynamically imported (./stage/render.ts) so three
        // is code-split out of the stage ENTRY chunk (join-first — spec §6.5).
        stage: fileURLToPath(new URL('./src/stage/index.html', import.meta.url)),
        // The F2 Showrunner director console (C10, `?mode=director`). DOM-only —
        // NO three (a pure staff control surface); the size gate keeps it lean.
        director: fileURLToPath(new URL('./src/director/index.html', import.meta.url)),
        // The F23 Workshop builder (C35, `?mode=build`). Desktop-only — Three.js
        // gizmos + palette + undo + settle-preview + glyph seeder. Isolated into
        // its own entry chunk so it NEVER bloats funnel/main/stage. The builder
        // chunk carries three (via dynamic import boundary in the HTML), so the
        // size gate tracks it with a separate BUILDER_SOFT_BUDGET row.
        builder: fileURLToPath(new URL('./src/builder/index.html', import.meta.url)),
      },
      output: {
        // Stable, budget-checkable chunk file names for the funnel entries so
        // the size gate can find each chunk by name. `[name]` yields `main-*.js`
        // for the headset/desktop entry — the C33 (F22 Desktop Command, spec §7.22)
        // DESKTOP soft-budget row in tools/check-bundle-size.mjs measures it and
        // enforces the single-source guard (the main chunk must NOT statically reach
        // the stage-entry chunk; the desktop AUTO camera consumes the SHARED
        // events.ts mapping, not stage-only code).
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: (chunkInfo) => {
          const id = chunkInfo.facadeModuleId ?? '';
          if (id.endsWith('/funnel/ballot.ts')) return 'assets/funnel-ballot-[hash].js';
          if (id.endsWith('/funnel/crowd.ts')) return 'assets/funnel-crowd-[hash].js';
          if (id.endsWith('/funnel/wisp.ts')) return 'assets/funnel-wisp-[hash].js';
          if (id.endsWith('/funnel/wisp3d.ts')) return 'assets/funnel-wisp3d-[hash].js';
          if (id.endsWith('/funnel/exit.ts')) return 'assets/funnel-exit-[hash].js';
          // stage/stage.ts is the ENTRY facade (src/stage/index.html is an HTML input
          // entry), so Rollup routes it through entryFileNames ('assets/[name]-[hash].js')
          // not chunkFileNames — it emits as `stage-[hash].js`. No chunkFileNames rule
          // needed for the stage entry itself.
          // The lazy render governor (three) IS a split chunk, so name it explicitly.
          if (id.endsWith('/stage/render.ts')) return 'assets/stage-render-[hash].js';
          // The builder entry chunk (C35 ?mode=build — desktop-only, isolated).
          // The HTML entry uses entryFileNames → 'builder-[hash].js'; individual
          // builder sub-modules land here if split by Rollup.
          if (id.includes('/builder/')) return 'assets/builder-[name]-[hash].js';
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});

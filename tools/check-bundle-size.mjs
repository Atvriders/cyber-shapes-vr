#!/usr/bin/env node
/**
 * tools/check-bundle-size.mjs — the phone-funnel bundle-budget gate (spec §5.7).
 *
 * Builds the client (multi-entry) and asserts each funnel chunk's GZIPPED size
 * stays within its §5.7 budget, FAILING LOUDLY (non-zero exit) when over:
 *
 *   • ballot / crowd entries : < 100 KB gz     (DOM-only, zero permissions, the
 *                                                recruitment hook — must not pull three)
 *   • wisp entry (INITIAL)   : < 300 KB gz     (join-first; three is lazy-loaded
 *                                                AFTER the handshake, so it is NOT
 *                                                counted in the initial footprint)
 *
 * "Initial footprint" for an entry = the entry chunk + the transitive closure of
 * its STATIC imports (the ES `import … from "./x.js"` graph in the built output),
 * EXCLUDING anything only reachable via a dynamic `import()` (that is the whole
 * point of the wisp code-split: `three` sits behind `import('./wisp3d.js')`).
 *
 * This tool ALSO fails if a ballot/crowd chunk's static closure reaches the
 * `three` chunk at all — a stricter, intent-level guard than the raw byte budget
 * (the code-split proof from the brief), so a regression that pulls three into a
 * DOM entry fails even though three is huge and would blow the byte budget too.
 *
 * Dev-only: no new runtime deps; uses Node's built-in zlib + child_process.
 */

import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const CLIENT = resolve(REPO, 'packages/client');
const ASSETS = resolve(CLIENT, 'dist/assets');

const KB = 1024;
/** §5.7 budgets, in GZIPPED bytes. */
const BUDGETS = {
  ballot: 100 * KB,
  crowd: 100 * KB,
  wisp: 300 * KB,
};

/**
 * C33 (F22 Desktop Command, spec §7.22): the DESKTOP/headset main entry gets its
 * own SOFT budget — the initial footprint of the `main` entry (the headset/desktop
 * client incl. three + the desktop VIEW code). It is a SOFT ceiling (a warning, not
 * a hard fail): the desktop chunk legitimately carries three, so this exists to
 * catch a REGRESSION (e.g. a stage-only import leaking into the main chunk, which
 * §7.22 forbids) rather than to police the three baseline. The number tracks the
 * measured size with generous headroom; bump it deliberately with a note.
 */
const DESKTOP_SOFT_BUDGET = 1100 * KB;

/**
 * C35 (F23 Workshop, spec §7.23): the BUILDER entry chunk soft budget — the
 * desktop-only `?mode=build` chunk (Three.js gizmos + palette + undo + layouts +
 * glyph seeder). This is a SOFT ceiling: the builder legitimately carries three
 * (via the same shared chunk), so this exists to catch an unexpected bloat
 * regression. The builder chunk MUST NOT be statically imported by main/stage/funnel
 * (enforced by the stage-leak guard below — the same `reachesStageEntry` pattern
 * applied in reverse). Bump deliberately with a note.
 */
const BUILDER_SOFT_BUDGET = 1500 * KB;

/** Chunk file-name prefixes the multi-entry vite config emits (stable names). */
const PREFIX = {
  ballot: 'funnel-ballot-',
  crowd: 'funnel-crowd-',
  wisp: 'funnel-wisp-',
  wisp3d: 'funnel-wisp3d-',
  three: 'three.module-',
  // The headset/desktop main entry (index.html → src/main.ts). Carries three; the
  // desktop VIEW (C33) rides here. Soft-budgeted (below), never a hard fail.
  main: 'main-',
  // The stage ENTRY chunk (three-free — join-first). A REGRESSION guard: the desktop
  // main chunk must NEVER statically reach the stage entry (§7.22 single-source).
  //
  // The stage HTML entry is processed by `entryFileNames` (not `chunkFileNames`),
  // so Rollup emits it as `stage-[hash].js` — matching the prefix 'stage-' here.
  // (The old prefix 'stage-entry-' never matched because chunkFileNames only fires
  // for non-entry chunks; the entry facade uses entryFileNames instead.)
  stageEntry: 'stage-',
  // C35 (F23 Workshop): the builder entry chunk (?mode=build, desktop-only).
  // Soft-budgeted (BUILDER_SOFT_BUDGET). MUST NOT be statically reached by
  // main/funnel/stage (those chunks must not import builder/* at all).
  builder: 'builder-',
};

function log(...a) {
  console.log(...a);
}

/** Build the client so we measure the real emitted chunks. */
function build() {
  log('[size] building packages/client …');
  execFileSync('npm', ['run', '-w', 'packages/client', 'build'], {
    cwd: REPO,
    stdio: 'inherit',
  });
}

/** Find the single emitted asset whose basename starts with `prefix`. */
function findChunk(prefix) {
  if (!existsSync(ASSETS)) return null;
  const hit = readdirSync(ASSETS).find(
    (f) => f.startsWith(prefix) && f.endsWith('.js')
  );
  return hit ? join(ASSETS, hit) : null;
}

/** Gzipped byte size of a file. */
function gzSize(file) {
  return gzipSync(readFileSync(file)).length;
}

/**
 * The transitive closure of an entry's STATIC ES imports within dist/assets.
 * Follows `import … from "./x.js"` (and `export … from`), but NOT dynamic
 * `import("./x.js")` calls — those are lazily loaded and excluded from the
 * initial footprint (this is the code-split boundary).
 */
function staticClosure(entryFile) {
  const closure = new Set();
  const stack = [entryFile];
  while (stack.length) {
    const file = stack.pop();
    if (closure.has(file) || !existsSync(file)) continue;
    closure.add(file);
    const src = readFileSync(file, 'utf8');
    // Match STATIC import/export-from only. A leading `import(` (dynamic) is
    // excluded because the pattern requires `from` OR a bare side-effect import
    // string, and dynamic import has the form `import("…")` with a paren.
    const re = /(?:^|[;\s])(?:import|export)[^;]*?from\s*["']([^"']+)["']|(?:^|[;\s])import\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1] ?? m[2];
      if (!spec || !spec.startsWith('.')) continue;
      const dep = resolve(dirname(file), spec);
      if (existsSync(dep)) stack.push(dep);
    }
  }
  return closure;
}

/** Does an entry's STATIC closure reach the `three` chunk? (intent guard) */
function reachesThree(entryFile) {
  for (const f of staticClosure(entryFile)) {
    if (basename(f).startsWith(PREFIX.three)) return true;
  }
  return false;
}

/**
 * C33 (§7.22): does an entry's STATIC closure reach the STAGE ENTRY chunk? The
 * desktop main chunk must NEVER statically import stage-only code — the shared
 * `events.ts` mapping is the single source both consume, so the main chunk pulls
 * the mapping, not the stage. A hit here means a regression (a stage import leaked).
 */
function reachesStageEntry(entryFile) {
  for (const f of staticClosure(entryFile)) {
    if (basename(f).startsWith(PREFIX.stageEntry)) return true;
  }
  return false;
}

/**
 * C35 (§7.23): does an entry's STATIC closure reach the BUILDER ENTRY chunk?
 * The desktop main / funnel / stage chunks must NEVER statically import
 * builder-only code — the builder lives behind `?mode=build` and is an isolated
 * entry. A hit means a regression (a builder import leaked into the shared graph).
 *
 * Mirror of `reachesStageEntry` — the C33 pattern applied to the builder chunk.
 * Export name kept stable so bundleGuard.test.ts can inline and unit-test it.
 */
function reachesBuilder(entryFile) {
  for (const f of staticClosure(entryFile)) {
    if (basename(f).startsWith(PREFIX.builder)) return true;
  }
  return false;
}

/** Sum of gzipped sizes over a set of files (the initial-footprint metric). */
function gzClosureSize(entryFile) {
  let total = 0;
  for (const f of staticClosure(entryFile)) total += gzSize(f);
  return total;
}

function fmt(bytes) {
  return `${(bytes / KB).toFixed(1)} KB gz`;
}

function main() {
  build();

  const failures = [];
  const rows = [];

  // ── ballot / crowd: DOM-only, must not reach three, initial < 100 KB gz ──
  for (const name of ['ballot', 'crowd']) {
    const file = findChunk(PREFIX[name]);
    if (!file) {
      failures.push(`${name}: chunk not found (expected assets/${PREFIX[name]}*.js)`);
      continue;
    }
    const size = gzClosureSize(file);
    const budget = BUDGETS[name];
    const hitsThree = reachesThree(file);
    rows.push({ name, size, budget, hitsThree });
    if (hitsThree) {
      failures.push(
        `${name}: STATICALLY imports the three chunk — the ${name} entry must be DOM-only (spec §5.7 code-split)`
      );
    }
    if (size > budget) {
      failures.push(`${name}: ${fmt(size)} exceeds budget ${fmt(budget)}`);
    }
  }

  // ── wisp ENTRY: initial footprint < 300 KB gz, three must be LAZY only ──
  {
    const file = findChunk(PREFIX.wisp);
    if (!file) {
      failures.push(`wisp: entry chunk not found (expected assets/${PREFIX.wisp}*.js)`);
    } else {
      const size = gzClosureSize(file);
      const budget = BUDGETS.wisp;
      const hitsThree = reachesThree(file);
      rows.push({ name: 'wisp', size, budget, hitsThree });
      if (hitsThree) {
        failures.push(
          `wisp: three is in the wisp ENTRY's static graph — it must load lazily AFTER join (spec §5.7 join-first)`
        );
      }
      if (size > budget) {
        failures.push(`wisp: initial ${fmt(size)} exceeds budget ${fmt(budget)}`);
      }
    }
  }

  // ── Report ──
  log('\n[size] funnel bundle budgets (spec §5.7):');
  for (const r of rows) {
    const ok = r.size <= r.budget && !r.hitsThree ? 'OK  ' : 'FAIL';
    log(
      `  [${ok}] ${r.name.padEnd(7)} ${fmt(r.size).padStart(12)} / ${fmt(
        r.budget
      ).padStart(12)}${r.hitsThree ? '  (reaches three!)' : ''}`
    );
  }

  // ── C33 (§7.22): the DESKTOP main chunk — soft budget + stage-leak HARD guard ──
  // ── C35 (§7.23): + builder-leak HARD guard (mirror of stage-leak guard)      ──
  {
    const file = findChunk(PREFIX.main);
    if (!file) {
      // Not fatal (the entry name can vary), but note it so a rename is visible.
      log('\n[size] desktop main chunk not found (expected assets/main-*.js) — skipped');
    } else {
      const size = gzClosureSize(file);
      const hitsStage = reachesStageEntry(file);
      const hitsBuilder = reachesBuilder(file);
      const within = size <= DESKTOP_SOFT_BUDGET;
      log('\n[size] desktop main chunk (spec §7.22/§7.23 — soft budget):');
      log(
        `  [${within ? 'OK  ' : 'WARN'}] ${'main'.padEnd(7)} ${fmt(size).padStart(12)} / ${fmt(
          DESKTOP_SOFT_BUDGET
        ).padStart(12)} (soft)`
      );
      // The stage-leak guard is a HARD fail (the §7.22 single-source invariant).
      if (hitsStage) {
        failures.push(
          'main: STATICALLY imports the stage ENTRY chunk — the desktop AUTO camera must consume the SHARED events.ts mapping, not stage-only code (spec §7.22 single-source)'
        );
      }
      // C35 (§7.23): the builder-leak guard is also a HARD fail — builder is an
      // isolated ?mode=build entry and must NEVER be statically reached by main.
      if (hitsBuilder) {
        failures.push(
          'main: STATICALLY imports the builder entry chunk — the builder must remain isolated behind ?mode=build (spec §7.23 bundle isolation)'
        );
      }
      // The byte ceiling is SOFT: warn (never exit non-zero) so the three baseline
      // is not policed here, only a leak-driven regression.
      if (!within) {
        log(
          `  ⚠ desktop main ${fmt(size)} exceeds the SOFT budget ${fmt(
            DESKTOP_SOFT_BUDGET
          )} — investigate a possible regression, then bump the budget deliberately.`
        );
      }
    }
  }

  // ── C35 (§7.23): the BUILDER chunk — soft budget, never a hard fail ──────
  //
  // The builder entry emits as `builder-[hash].js` via `entryFileNames` (the
  // rollupOptions.input key is 'builder', so Vite uses [name]='builder').
  // We find the chunk via PREFIX.builder = 'builder-' (which matches the entry
  // chunk emitted by entryFileNames, NOT chunkFileNames). If the chunk somehow
  // shares a different name (e.g. Vite deduplication), we fall through to the
  // "not found" branch rather than silently measuring the wrong chunk.
  {
    const file = findChunk(PREFIX.builder);
    if (!file) {
      // The builder entry was not found under assets/builder-*.js. This is
      // flagged as a WARNING (not a hard fail) but is tracked as a failure so
      // the CI output is visible. A missing builder chunk means the entry was
      // either DCE'd (the bootstrap side-effect is absent) or renamed.
      failures.push(
        'builder: entry chunk not found (expected assets/builder-*.js) — builder may have been tree-shaken (no top-level side-effect) or renamed; this is a C35 regression'
      );
      log('\n[size] builder chunk (spec §7.23 — soft budget):');
      log('  [FAIL] builder — chunk not found (see failure list)');
    } else {
      const size = gzClosureSize(file);
      const within = size <= BUILDER_SOFT_BUDGET;
      log('\n[size] builder chunk (spec §7.23 — soft budget):');
      log(
        `  [${within ? 'OK  ' : 'WARN'}] ${'builder'.padEnd(7)} ${fmt(size).padStart(12)} / ${fmt(
          BUILDER_SOFT_BUDGET
        ).padStart(12)} (soft)`
      );
      if (!within) {
        log(
          `  ⚠ builder ${fmt(size)} exceeds the SOFT budget ${fmt(
            BUILDER_SOFT_BUDGET
          )} — investigate a possible regression, then bump the budget deliberately.`
        );
      }
    }
  }

  if (failures.length) {
    log('\n[size] BUDGET GATE FAILED:');
    for (const f of failures) log(`  ✗ ${f}`);
    process.exit(1);
  }
  log('\n[size] all funnel chunks within budget ✓');
}

main();

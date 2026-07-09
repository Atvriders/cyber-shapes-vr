/**
 * bundleGuard.test.ts — unit tests for the C33 stage-leak bundle guard.
 *
 * The guard in tools/check-bundle-size.mjs detects whether the desktop `main`
 * entry's STATIC import graph reaches the stage entry chunk (a §7.22 violation).
 * This file tests the predicate logic directly against synthetic fixtures (no real
 * build needed), proving the guard is NOT a no-op: it returns true (fail) when
 * main DOES statically import the stage entry and false (pass) when it does not.
 *
 * The production fix (C33): the old prefix 'stage-entry-' never matched because
 * the stage HTML entry is processed by entryFileNames (not chunkFileNames), so the
 * real emitted chunk is 'stage-[hash].js'. The guard now uses prefix 'stage-'.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';

// ---------------------------------------------------------------------------
// Inline the predicate logic from tools/check-bundle-size.mjs so we can unit-
// test it without triggering the tool's build step.
// ---------------------------------------------------------------------------

/**
 * Transitive closure of an entry's STATIC ES imports within a directory.
 * Mirrors the production staticClosure() in check-bundle-size.mjs.
 */
function staticClosure(entryFile: string): Set<string> {
  const closure = new Set<string>();
  const stack = [entryFile];
  while (stack.length) {
    const file = stack.pop()!;
    if (closure.has(file) || !existsSync(file)) continue;
    closure.add(file);
    const src = readFileSync(file, 'utf8');
    const re =
      /(?:^|[;\s])(?:import|export)[^;]*?from\s*["']([^"']+)["']|(?:^|[;\s])import\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1] ?? m[2];
      if (!spec || !spec.startsWith('.')) continue;
      const dep = resolve(dirname(file), spec);
      if (existsSync(dep)) stack.push(dep);
    }
  }
  return closure;
}

/** Does an entry's static closure reach the stage entry chunk? */
function reachesStageEntry(entryFile: string, stagePrefix: string): boolean {
  for (const f of staticClosure(entryFile)) {
    if (basename(f).startsWith(stagePrefix)) return true;
  }
  return false;
}

/**
 * C35 (§7.23): does an entry's static closure reach the BUILDER entry chunk?
 * Mirrors reachesStageEntry — the C33 guard pattern applied to the builder.
 */
function reachesBuilder(entryFile: string, builderPrefix: string): boolean {
  for (const f of staticClosure(entryFile)) {
    if (basename(f).startsWith(builderPrefix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers to build a tiny synthetic dist/assets directory in a temp folder.
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bundle-guard-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write a minimal synthetic chunk file. `staticImports` are relative paths
 * (e.g. './stage-abc123.js') that will be written as real files alongside.
 */
function writeChunk(name: string, staticImports: string[] = [], content = ''): string {
  const path = join(tmpDir, name);
  const importLines = staticImports
    .map((s) => `import './${s}';`)
    .join('\n');
  writeFileSync(path, `${importLines}\n${content}`);
  return path;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reachesStageEntry — the C33 stage-leak bundle guard predicate', () => {
  const STAGE_PREFIX = 'stage-'; // the FIXED prefix (was dead 'stage-entry-')

  it('returns FALSE when main has no static imports (clean build — today)', () => {
    // Simulates the current clean build: main-[hash].js does NOT import stage-[hash].js
    const mainChunk = writeChunk('main-abc123.js', [], '// desktop main, no stage import');
    writeChunk('stage-def456.js', [], '// stage entry chunk');

    const result = reachesStageEntry(mainChunk, STAGE_PREFIX);
    expect(result).toBe(false);
  });

  it('returns TRUE when main DIRECTLY imports the stage entry chunk (regression)', () => {
    // RED PROOF: simulates the forbidden regression — main statically reaches stage.
    writeChunk('stage-def456.js', [], '// stage entry chunk');
    const mainChunk = writeChunk('main-abc123.js', ['stage-def456.js']);

    const result = reachesStageEntry(mainChunk, STAGE_PREFIX);
    expect(result).toBe(true);
  });

  it('returns TRUE when main reaches stage TRANSITIVELY (indirect regression)', () => {
    // main → shared-xyz.js → stage-def456.js  (transitive static import leak)
    writeChunk('stage-def456.js', [], '// stage entry');
    writeChunk('shared-xyz.js', ['stage-def456.js']);
    const mainChunk = writeChunk('main-abc123.js', ['shared-xyz.js']);

    const result = reachesStageEntry(mainChunk, STAGE_PREFIX);
    expect(result).toBe(true);
  });

  it('does NOT follow dynamic imports (lazy import() is not a regression)', () => {
    // Dynamic import('stage-def456.js') must NOT be counted as a static import.
    const mainChunk = join(tmpDir, 'main-abc123.js');
    writeFileSync(mainChunk, `
// The 3D render governor is loaded lazily — this is fine.
const lazyStage = () => import('./stage-def456.js');
`);
    writeChunk('stage-def456.js', [], '// stage entry');

    const result = reachesStageEntry(mainChunk, STAGE_PREFIX);
    expect(result).toBe(false);
  });

  it('DEAD prefix "stage-entry-" would miss the stage chunk (proves the old guard was broken)', () => {
    // Demonstrates the BUG that was fixed in C33: the old prefix 'stage-entry-' never
    // matched 'stage-def456.js' (the real emitted name), so the guard was a no-op even
    // when main DID statically import the stage chunk.
    const DEAD_PREFIX = 'stage-entry-'; // the old, broken prefix
    writeChunk('stage-def456.js', [], '// stage entry — real emitted name');
    const mainChunk = writeChunk('main-abc123.js', ['stage-def456.js']); // regression present!

    // With the OLD (dead) prefix: guard returns false even though main reaches stage
    const deadGuardResult = reachesStageEntry(mainChunk, DEAD_PREFIX);
    expect(deadGuardResult).toBe(false); // <-- proves the old guard was a no-op

    // With the FIXED prefix: guard correctly returns true
    const fixedGuardResult = reachesStageEntry(mainChunk, STAGE_PREFIX);
    expect(fixedGuardResult).toBe(true); // <-- the fix works
  });

  it('ignores non-stage chunks that happen to contain "stage" in a different position', () => {
    // e.g. 'funnel-backstage-abc.js' must NOT match the stage-entry prefix 'stage-'
    // because it does not START with 'stage-'.
    writeChunk('funnel-backstage-abc.js', [], '// unrelated chunk');
    const mainChunk = writeChunk('main-abc123.js', ['funnel-backstage-abc.js']);

    const result = reachesStageEntry(mainChunk, STAGE_PREFIX);
    expect(result).toBe(false);
  });
});

// ===========================================================================
// reachesBuilder — C35 (§7.23) builder-leak guard
//
// RED-PROOF unit tests for the reachesBuilder guard: synthetic manifest where
// main imports the builder chunk → guard returns true (fails); where it doesn't
// → guard returns false (passes). Mirrors the C33 reachesStageEntry tests.
// ===========================================================================

describe('reachesBuilder — the C35 builder-leak bundle guard predicate', () => {
  const BUILDER_PREFIX = 'builder-'; // the prefix entryFileNames emits for the builder entry

  it('returns FALSE when main has no static imports — clean build (PASS)', () => {
    // The expected clean state: main-[hash].js does NOT import builder-[hash].js
    const mainChunk = writeChunk('main-abc123.js', [], '// desktop main, no builder import');
    writeChunk('builder-def456.js', [], '// builder entry chunk');

    const result = reachesBuilder(mainChunk, BUILDER_PREFIX);
    expect(result).toBe(false);
  });

  it('returns TRUE when main DIRECTLY imports the builder entry chunk (regression — RED PROOF)', () => {
    // RED PROOF: simulates the forbidden regression — main statically reaches builder.
    // This is the scenario the guard must catch.
    writeChunk('builder-def456.js', [], '// builder entry chunk');
    const mainChunk = writeChunk('main-abc123.js', ['builder-def456.js']);

    const result = reachesBuilder(mainChunk, BUILDER_PREFIX);
    expect(result).toBe(true); // guard fires → hard fail
  });

  it('returns TRUE when main reaches builder TRANSITIVELY (indirect regression)', () => {
    // main → shared-xyz.js → builder-def456.js  (transitive builder import leak)
    writeChunk('builder-def456.js', [], '// builder entry');
    writeChunk('shared-xyz.js', ['builder-def456.js']);
    const mainChunk = writeChunk('main-abc123.js', ['shared-xyz.js']);

    const result = reachesBuilder(mainChunk, BUILDER_PREFIX);
    expect(result).toBe(true);
  });

  it('does NOT follow dynamic imports (lazy import() of builder is fine)', () => {
    // A dynamic import('builder-def456.js') must NOT be counted as a static import.
    // (The builder could be dynamically loaded from a ?mode=build shell — that is allowed.)
    const mainChunk = join(tmpDir, 'main-abc123.js');
    writeFileSync(mainChunk, `
// Builder loaded dynamically — this is fine (it's an isolated ?mode=build entry).
if (searchParams.get('mode') === 'build') { import('./builder-def456.js'); }
`);
    writeChunk('builder-def456.js', [], '// builder entry');

    const result = reachesBuilder(mainChunk, BUILDER_PREFIX);
    expect(result).toBe(false); // dynamic import is NOT a static import
  });

  it('ignores non-builder chunks that contain "builder" in a different position', () => {
    // e.g. 'funnel-builder-mock-abc.js' must NOT match prefix 'builder-'
    // because it does not START with 'builder-'.
    writeChunk('funnel-builder-mock-abc.js', [], '// unrelated chunk');
    const mainChunk = writeChunk('main-abc123.js', ['funnel-builder-mock-abc.js']);

    const result = reachesBuilder(mainChunk, BUILDER_PREFIX);
    expect(result).toBe(false);
  });

  it('C33 stage guard still passes — the two guards are independent (no regression)', () => {
    // Ensures adding the builder guard did not break the stage guard.
    const STAGE_PREFIX = 'stage-';
    writeChunk('stage-abc.js', [], '// stage chunk');
    const mainChunk = writeChunk('main-xyz.js', ['stage-abc.js']); // stage leak

    // Stage guard fires
    const stageHit = reachesStageEntry(mainChunk, STAGE_PREFIX);
    expect(stageHit).toBe(true);

    // Builder guard does NOT fire (no builder-* chunk in the closure)
    const builderHit = reachesBuilder(mainChunk, BUILDER_PREFIX);
    expect(builderHit).toBe(false);
  });
});

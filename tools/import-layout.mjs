// ---------------------------------------------------------------------------
// tools/import-layout.mjs — the no-UI rung for F23 The Workshop (spec §7.23, C34).
//
// "No builder UI (C35 cut, C34 landed) → layouts remain loadable via a documented
//  JSON file + `tools/import-layout.mjs`." (spec §7.23 Rungs.)
//
// Reads a HAND-WRITTEN layout JSON file, validates it against the shared, pure
// `validateLayout` (the SAME gate the server uses), settle-BAKES it (deterministic
// `settleBake`, wind/freeze/attractors stripped), and writes it into a room's
// `layouts` bucket file — optionally marking it the SHOWROOM BASELINE the RESET
// handler restores. So a club can compose a showroom in a text editor with no
// server running and no builder UI, exactly the degrade rung the spec promises.
//
// The bucket file layout MUST match packages/server/src/buckets.ts:LayoutBucket —
//   <dataDir>/buckets/layouts/<roomId>.json  →  { layouts: Layout[], baselineName? }
//
// Usage:
//   node tools/import-layout.mjs <layout.json> --room <roomId> [options]
//
// Options:
//   --room <id>       (required) the room to import the layout into.
//   --data-dir <dir>  the server data dir (default: ./data). The file is written
//                     under <dir>/buckets/layouts/<roomId>.json.
//   --baseline        mark the imported layout as the showroom baseline (validated
//                     against the STRICTER baseline cap: MAX_SHAPES − METEOR_BUDGET).
//   --print           validate + bake + print the result to stdout; write NOTHING.
//
// Exit code 0 on success; 1 on a validation error / bad args (with a message).
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { validateLayout, settleBake, DEFAULT_PARAMS } from '@cyber-shapes/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

/** Parse argv into { file, room, dataDir, baseline, print }. */
function parseArgs(argv) {
  const out = { file: undefined, room: undefined, dataDir: 'data', baseline: false, print: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--room') out.room = argv[++i];
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a === '--baseline') out.baseline = true;
    else if (a === '--print') out.print = true;
    else if (!a.startsWith('--') && out.file === undefined) out.file = a;
  }
  return out;
}

const BUCKET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function fail(msg) {
  console.error(`[import-layout] ${msg}`);
  process.exit(1);
}

/**
 * The importer body. Exported (and unit-tested) so the integration test drives it
 * without spawning a subprocess. Returns the baked manifest (never writes when
 * `print`); throws an Error with a machine-readable message on any failure.
 */
export function importLayout({ file, room, dataDir = 'data', baseline = false, print = false }) {
  if (!file) throw new Error('no layout file given');
  if (!room || !BUCKET_ID_RE.test(room)) throw new Error('missing/invalid --room');

  const raw = readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid JSON in ${file}`);
  }

  // Validate against the SAME shared gate the server uses (baseline → the stricter
  // reserve cap, MAX_SHAPES − METEOR_BUDGET; play → MAX_SHAPES).
  const v = validateLayout(parsed, baseline);
  if (!v.ok) throw new Error(`layout rejected: ${v.reason}${v.index !== undefined ? ` @${v.index}` : ''}`);

  // BAKE deterministically under DEFAULT_PARAMS (the baseline settles under the
  // booth physics; wind/freeze/attractors stripped by settleBake).
  const baked = settleBake(v.layout, DEFAULT_PARAMS).layout;

  if (print) {
    return { layouts: [baked], ...(baseline ? { baselineName: baked.name } : {}) };
  }

  // Merge into the existing manifest (upsert by name), matching LayoutBucket's file.
  const bucketPath = resolve(REPO, dataDir, 'buckets', 'layouts', `${room}.json`);
  let manifest = { layouts: [] };
  if (existsSync(bucketPath)) {
    try {
      const existing = JSON.parse(readFileSync(bucketPath, 'utf8'));
      if (existing && Array.isArray(existing.layouts)) manifest = existing;
    } catch {
      /* corrupt file → start fresh (the server's validate-on-load agrees) */
    }
  }
  const idx = manifest.layouts.findIndex((l) => l && l.name === baked.name);
  if (idx === -1) manifest.layouts.push(baked);
  else manifest.layouts[idx] = baked;
  if (baseline) manifest.baselineName = baked.name;

  mkdirSync(dirname(bucketPath), { recursive: true });
  writeFileSync(bucketPath, JSON.stringify(manifest), 'utf8');
  return manifest;
}

// CLI entry (only when run directly, not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = importLayout(args);
    if (args.print) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      const n = result.layouts.length;
      const which = args.baseline ? ' (marked as the showroom baseline)' : '';
      console.log(
        `[import-layout] imported "${args.file}" into room "${args.room}" — ${n} layout(s) now saved${which}.`
      );
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

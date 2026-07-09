#!/usr/bin/env node
/**
 * tools/preflight/cli.mjs — Task C23: the booth preflight, runnable from a
 * terminal (no browser needed). Companion to tools/preflight/index.html (the
 * browser page a staffer opens on the stage laptop) — same GET /api/preflight
 * endpoint, printed as clear green/red terminal output.
 *
 * Usage:
 *   node tools/preflight/cli.mjs                       # http://localhost:3030
 *   node tools/preflight/cli.mjs --url http://192.168.1.50:3030
 *   node tools/preflight/cli.mjs --key <STAFF_KEY>      # off-LAN / remote check
 *   PREFLIGHT_URL=http://booth.local:3030 node tools/preflight/cli.mjs
 *
 * Exit code: 0 when every check is green (server checks 'ok' AND both manual
 * prompts confirmed), 1 otherwise — so this is CI/script-friendly.
 *
 * HONESTY (spec brief — "a checklist item that prompts, not a fake automated
 * pass"): the server's `stage-watchdog` and `headset-battery` checks are ALWAYS
 * manual prompts (no automated signal exists for either — see preflight.ts doc
 * comments). This CLI does NOT silently treat them as passing. When run from an
 * interactive terminal (a TTY) it ASKS the staffer y/n for each; when run
 * non-interactively (CI, a dry-run, piped output) it reports them as pending
 * MANUAL items and does not claim a pass.
 *
 * Dev-only: no new runtime deps — Node 20's built-in `fetch` + `readline`.
 */

import readline from 'node:readline';

// ---------------------------------------------------------------------------
// Args / config
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) out.url = argv[++i];
    else if (argv[i] === '--key' && argv[i + 1]) out.key = argv[++i];
    else if (argv[i] === '--no-prompt') out.noPrompt = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const BASE = args.url ?? process.env.PREFLIGHT_URL ?? 'http://localhost:3030';
const URL = BASE.replace(/\/$/, '') + '/api/preflight';
const STAFF_KEY = args.key ?? process.env.STAFF_KEY;

// ---------------------------------------------------------------------------
// Terminal formatting (ANSI; degrades harmlessly on a dumb terminal)
// ---------------------------------------------------------------------------

const COLOR = process.stdout.isTTY;
const c = {
  green: (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  dim: (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s),
};

function dot(status) {
  if (status === 'ok') return c.green('[ OK ]');
  if (status === 'warn') return c.yellow('[WARN]');
  return c.red('[FAIL]');
}

function row(name, status, message) {
  console.log(`  ${dot(status)} ${name.padEnd(16)} ${message}`);
}

// ---------------------------------------------------------------------------
// Interactive y/n prompt (skipped when not a TTY — never hangs a dry-run)
// ---------------------------------------------------------------------------

function askYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  ${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

const MANUAL_CHECKS = {
  'stage-watchdog': 'Is the STAGE screen currently rendering (not frozen / not stuck on reload)?',
  'headset-battery': 'Are BOTH A/B headsets sufficiently charged?',
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(c.bold('cyber-shapes-vr — booth preflight'));
  console.log(c.dim(`  checking ${URL}`));
  console.log('');

  let data;
  try {
    const headers = STAFF_KEY ? { Authorization: `Bearer ${STAFF_KEY}` } : {};
    const res = await fetch(URL, { headers });
    if (!res.ok) {
      console.log(c.red(`[FAIL] server responded ${res.status} ${res.statusText}`));
      if (res.status === 401) {
        console.log(
          c.dim(
            '  off-LAN callers need --key <STAFF_KEY> (or run this from the booth LAN/loopback).'
          )
        );
      }
      process.exitCode = 1;
      return;
    }
    data = await res.json();
  } catch (err) {
    console.log(c.red(`[FAIL] could not reach ${URL}: ${err.message ?? err}`));
    console.log(c.dim('  is the server running? try --url or PREFLIGHT_URL.'));
    process.exitCode = 1;
    return;
  }

  console.log(c.bold(`mode: ${data.mode ?? '?'}`) + c.dim(`   (checked at ${data.timestamp ?? '?'})`));
  console.log('');
  console.log(c.bold('server checks:'));

  let allGreen = true;
  const manualNeeded = [];

  for (const check of data.checks ?? []) {
    if (check.name in MANUAL_CHECKS) {
      // These two are ALWAYS server-side 'warn' stubs (never a fake pass) — the
      // CLI resolves them itself below (interactively or as a pending prompt),
      // not from the server's stub status.
      manualNeeded.push(check.name);
      continue;
    }
    row(check.name, check.status, check.message);
    if (check.status !== 'ok') allGreen = false;
  }

  if (manualNeeded.length > 0) {
    console.log('');
    console.log(c.bold('manual checklist (no automated signal exists — see RUNBOOK):'));
    const interactive = process.stdin.isTTY && !args.noPrompt;
    for (const name of manualNeeded) {
      if (interactive) {
        const confirmed = await askYesNo(MANUAL_CHECKS[name]);
        row(name, confirmed ? 'ok' : 'fail', confirmed ? 'confirmed by staff' : 'NOT confirmed');
        if (!confirmed) allGreen = false;
      } else {
        row(name, 'warn', `PENDING — run interactively to confirm, or see RUNBOOK: ${MANUAL_CHECKS[name]}`);
        allGreen = false;
      }
    }
  }

  console.log('');
  if (allGreen) {
    console.log(c.green(c.bold('ALL GREEN — booth-ready.')));
  } else {
    console.log(c.yellow(c.bold('NOT all green — see the rows above before opening the room.')));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(c.red(`[FAIL] preflight CLI crashed: ${err?.stack ?? err}`));
  process.exitCode = 1;
});

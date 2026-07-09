// preflight.js — External script for tools/preflight/index.html
// Extracted from inline script to comply with CSP script-src 'self' (XSS fix, Task C8).
// All server-controlled values are inserted via textContent — never innerHTML.

// ---------------------------------------------------------------------------
// Safe DOM helpers — no innerHTML with server-controlled values (XSS guard)
// ---------------------------------------------------------------------------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

// ---------------------------------------------------------------------------
// Fetch /api/preflight and render results
// ---------------------------------------------------------------------------
async function runChecks() {
  const rows = document.getElementById('check-rows');
  const badge = document.getElementById('overall-badge');
  const modeBadge = document.getElementById('mode-badge');
  const ts = document.getElementById('ts');
  if (!rows || !badge || !modeBadge || !ts) return;

  // Loading placeholder (static text — safe)
  rows.textContent = '';
  const loadRow = el('div', 'check-row');
  loadRow.appendChild(el('div', 'dot pending'));
  loadRow.appendChild(el('span', 'check-msg', 'Running…'));
  rows.appendChild(loadRow);
  badge.className = 'overall-badge pending';
  badge.textContent = '—';

  let data;
  try {
    const res = await fetch('/api/preflight');
    data = await res.json();
  } catch (e) {
    rows.textContent = '';
    const errRow = el('div', 'check-row');
    errRow.appendChild(el('div', 'dot fail'));
    // e.message is a browser-generated string (not server data); safe via textContent
    errRow.appendChild(el('span', 'check-msg',
      'Could not reach /api/preflight: ' + (e && e.message ? e.message : String(e))));
    rows.appendChild(errRow);
    badge.className = 'overall-badge fail';
    badge.textContent = 'FAIL';
    return;
  }

  // Restrict overall status to known CSS class names (strip non-alpha)
  const safeOverall = String(data.overall || 'fail').replace(/[^a-z]/g, '');
  badge.className = 'overall-badge ' + safeOverall;
  badge.textContent = safeOverall.toUpperCase();
  modeBadge.textContent = 'mode: ' + String(data.mode || '?');
  ts.textContent = 'checked at ' + String(data.timestamp || '');

  rows.textContent = '';
  for (const c of (data.checks || [])) {
    const row = el('div', 'check-row');
    // Restrict status to known safe CSS class names
    const safeStatus = String(c.status || '').replace(/[^a-z]/g, '');
    row.appendChild(el('div', 'dot ' + safeStatus));
    row.appendChild(el('span', 'check-name', c.name));
    row.appendChild(el('span', 'check-msg', c.message));
    row.appendChild(el('span', 'check-val', c.value != null ? c.value : ''));
    rows.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Browser-side checks
// ---------------------------------------------------------------------------
async function testAutoplay() {
  const dot = document.getElementById('bc-autoplay-dot');
  if (!dot) return;
  try {
    const audio = new Audio();
    audio.volume = 0;
    await audio.play();
    audio.pause();
    dot.className = 'dot ok';
  } catch {
    dot.className = 'dot warn';
  }
}

async function testMic() {
  const dot = document.getElementById('bc-mic-dot');
  if (!dot) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    dot.className = 'dot ok';
  } catch (e) {
    dot.className = 'dot fail';
    console.warn('mic/speaker:', e);
  }
}

// ---------------------------------------------------------------------------
// Wire up event listeners (replaces inline onclick attributes removed for CSP)
// ---------------------------------------------------------------------------
document.getElementById('refresh-btn')?.addEventListener('click', runChecks);
document.getElementById('autoplay-btn')?.addEventListener('click', testAutoplay);
document.getElementById('mic-btn')?.addEventListener('click', testMic);

// Auto-run on load.
runChecks();

// ---------------------------------------------------------------------------
// casterGrammar.ts — F15 MC NULL: the PURE procedural caster grammar (C26,
// spec §7.15). No Date, no Math.random, no I/O, no THREE, no DOM. Injected RNG
// only. The stateful host (streaks / LRU / quota / rotation-scoping / phase
// source / day-stats reads / single caption authority) is
// `packages/server/src/caster.ts`; THIS module is the pure vocabulary + the
// pure `casterLine(event, ctx, rng)` decision + the wire (de)serialization +
// the client-side text renderer.
//
// THE PROTOCOL INVARIANT (spec §7.15 / Appendix B): the CASTER_LINE wire frame
// carries `{templateId: u16, slots}` where every slot is an INDEX or a
// FIXED-POINT NUMBER — NEVER a raw string. The stage RENDERS text from
// (templateId + slots) via {@link renderCasterLine}; it NEVER generates a line.
// A callsign slot is SELF-CONTAINED — (curated-wordlist index, numeric suffix)
// — so crowd/audience render "VOLT-17" WITHOUT a roster (spec §7.15 "no tier
// needs a roster to render captions").
//
// SILENCE (null) is the DEFAULT (spec §7.15 "no filler, ever"): `casterLine`
// returns null unless a moment clears the SHARED significance floor (reused from
// the C21 highlight scorer — {@link CASTER_SCORER_CFG}, never reimplemented) AND
// a non-recently-used template variant exists for the phase-selected intensity.
// ---------------------------------------------------------------------------

import { CURATED_WORDLIST, type Rng } from './callsigns.js';
import { DEFAULT_HIGHLIGHT_SCORER_CFG } from './stageBrain.js';
import type { Phase } from './cues.js';

// ---------------------------------------------------------------------------
// Fixed-point + budget constants.
// ---------------------------------------------------------------------------

/**
 * Fixed-point scale for a numeric slot: the wire int is `round(value * SCALE)`
 * and the renderer divides back by SCALE. SCALE=10 keeps one decimal of speed
 * ("18.4 M/S") while integers (streak counts) render cleanly.
 */
export const CASTER_FIXED_SCALE = 10;

/** Per-line hard character budget (5-metre legibility, spec §7.15). */
export const CASTER_LINE_CHAR_BUDGET = 42;

/** Max lines per caption (spec §7.15 "max 2 lines"). */
export const CASTER_MAX_LINES = 2;

/** A callsign numeric suffix is a u8 on the wire (spec §7.15). */
export const CASTER_SUFFIX_MAX = 255;

/**
 * The significance floor the caster shares with the C21 highlight scorer — the
 * "reduced signal set" agreement (spec §7.15: "caster and replay agree on what
 * counts"). REUSED, never reimplemented: it is exactly the scorer's default cfg
 * so a shared-thresholds test can assert byte-equality of the floors.
 */
export const CASTER_SCORER_CFG = DEFAULT_HIGHLIGHT_SCORER_CFG;

/** A streak reaches "milestone" (a streak line becomes eligible) at this length. */
export const CASTER_STREAK_MIN = 3;

// ---------------------------------------------------------------------------
// Event kinds + slots.
// ---------------------------------------------------------------------------

/**
 * The caster's event vocabulary. `throw`/`impact`/`shapeRain`/`grabDuel` mirror
 * the shared highlight scorer's reduced signal set; `join`/`streak`/`record` are
 * caster-specific; `arm`/`endCard` are the ONLY kinds allowed while a showpiece
 * owns the caption (single caption authority, spec §7.15).
 */
export type CasterEventKind =
  | 'throw'
  | 'impact'
  | 'streak'
  | 'record'
  | 'shapeRain'
  | 'grabDuel'
  | 'join'
  | 'arm'
  | 'endCard';

/** A self-contained callsign reference (renders WITHOUT a roster). */
export interface CasterCallsign {
  /** Index into {@link CURATED_WORDLIST} (u16). */
  wordIndex: number;
  /** Numeric suffix (u8 per §7.15; e.g. 17 → "VOLT-17"). */
  suffix: number;
}

/**
 * A resolved slot value. `num.value` is the REAL value (the wire fixed-point is
 * derived at serialization); `callsign` is the self-contained reference.
 */
export type CasterSlot =
  | { kind: 'num'; value: number }
  | { kind: 'callsign'; who: CasterCallsign };

/**
 * A significant moment handed to {@link casterLine}. The host builds this from
 * its own event stream + the shared scorer + day-stats reads. Numeric fields are
 * NAMED after their source SIGNAL so the label↔signal-truth test can verify each
 * template binds the right one (THROW = release velocity, IMPACT = impactSpeed,
 * superlatives only on a real record).
 */
export type CasterEvent =
  | { kind: 'throw'; who: CasterCallsign; releaseVel: number }
  | { kind: 'streak'; who: CasterCallsign; streakCount: number }
  | { kind: 'impact'; who: CasterCallsign; impactSpeed: number }
  | { kind: 'record'; who: CasterCallsign; recordSpeed: number }
  | { kind: 'shapeRain'; spawnCount: number }
  | { kind: 'grabDuel'; who: CasterCallsign }
  | { kind: 'join'; who: CasterCallsign }
  | { kind: 'arm'; who?: CasterCallsign }
  | { kind: 'endCard'; who: CasterCallsign; catches: number };

/** The line-intensity tiers the phase hype ladder selects among (spec §7.15). */
export type CasterIntensity = 'calm' | 'normal' | 'hype';

/**
 * The phase hype ladder: map the room phase → a line-intensity tier (spec §7.15
 * "LOBBY calm → PLAY normal → OVERLOAD/FINALE hype"). It ONLY changes which
 * template variant is selected; it NEVER changes the quota.
 */
export function intensityForPhase(phase: Phase): CasterIntensity {
  switch (phase) {
    case 'PLAY':
      return 'normal';
    case 'OVERLOAD':
    case 'FINALE':
      return 'hype';
    // LOBBY / STATS / ATTRACT / RESET — calm.
    default:
      return 'calm';
  }
}

/** The `ctx` a caster line is rendered under. */
export interface CasterCtx {
  /** The room phase — drives the hype ladder (calm/normal/hype). */
  phase: Phase;
  /**
   * Template ids to AVOID (the host's ~3-min no-repeat LRU). A candidate in this
   * set is never chosen — if it leaves the phase-intensity group empty, the line
   * is SILENCE (no-repeat is enforced by omission, keeping `casterLine` pure).
   */
  avoidTemplateIds?: ReadonlySet<number>;
}

// ---------------------------------------------------------------------------
// Slot specs — the label↔signal-truth contract.
// ---------------------------------------------------------------------------

/** The signal a numeric slot BINDS (label↔signal truth, spec §7.15). */
export type CasterSignal =
  | 'releaseVel'
  | 'impactSpeed'
  | 'streakCount'
  | 'recordSpeed'
  | 'spawnCount'
  | 'catches';

/** One slot's declared shape: a callsign, or a number bound to a named signal. */
export type CasterSlotSpec =
  | { type: 'callsign' }
  | { type: 'num'; decimals: 0 | 1; signal: CasterSignal };

/** A single template — a stable id + its kind/intensity/priority + render fn. */
export interface CasterTemplate {
  /** Stable u16 id (its index in {@link CASTER_TEMPLATES} — NEVER reordered). */
  id: number;
  kind: CasterEventKind;
  intensity: CasterIntensity;
  /** 1 = highest (records / showpiece arm-end), 3 = ambient. Drives TTS ducking. */
  priority: 1 | 2 | 3;
  /** The ordered slot specs this template consumes. */
  slots: CasterSlotSpec[];
  /** Render the final caption from already-resolved slot strings (≤2 lines). */
  render: (s: string[]) => string;
}

// A compact template author helper. `slots` is inferred from `render`'s use, so
// each entry declares it explicitly for the label↔signal-truth test.
interface TemplateDef {
  kind: CasterEventKind;
  intensity: CasterIntensity;
  priority: 1 | 2 | 3;
  slots: CasterSlotSpec[];
  render: (s: string[]) => string;
}

const CS: CasterSlotSpec = { type: 'callsign' };
const numSlot = (signal: CasterSignal, decimals: 0 | 1 = 0): CasterSlotSpec => ({
  type: 'num',
  decimals,
  signal,
});

// ---------------------------------------------------------------------------
// The template table — club-written authored copy (the repo-reviewed content
// gate + owner read-through artifact, spec §7.15). ≥ 3 variants per event kind;
// each frequent kind carries a calm/normal/hype tier for the phase ladder. NEVER
// REORDER (ids are positional and referenced by golden transcripts).
// ---------------------------------------------------------------------------

const DEFS: TemplateDef[] = [
  // --- throw (num = releaseVel) ------------------------------------------
  { kind: 'throw', intensity: 'calm', priority: 3, slots: [CS, numSlot('releaseVel', 1)], render: (s) => `${s[0]} LETS ONE FLY · ${s[1]} M/S` },
  { kind: 'throw', intensity: 'calm', priority: 3, slots: [CS, numSlot('releaseVel', 1)], render: (s) => `${s[0]} WINDS UP · ${s[1]} M/S` },
  { kind: 'throw', intensity: 'normal', priority: 2, slots: [CS, numSlot('releaseVel', 1)], render: (s) => `${s[0]} RIPS IT · ${s[1]} M/S` },
  { kind: 'throw', intensity: 'normal', priority: 2, slots: [CS, numSlot('releaseVel', 1)], render: (s) => `${s[0]} ON A ROCKET · ${s[1]} M/S` },
  { kind: 'throw', intensity: 'hype', priority: 2, slots: [CS, numSlot('releaseVel', 1)], render: (s) => `${s[0]} GOES SUPERSONIC · ${s[1]} M/S` },
  { kind: 'throw', intensity: 'hype', priority: 2, slots: [CS, numSlot('releaseVel', 1)], render: (s) => `${s[0]} UNLOADS · ${s[1]} M/S!` },

  // --- impact (num = impactSpeed) ----------------------------------------
  { kind: 'impact', intensity: 'calm', priority: 3, slots: [CS, numSlot('impactSpeed', 1)], render: (s) => `${s[0]} TOUCHES DOWN · ${s[1]} M/S` },
  { kind: 'impact', intensity: 'normal', priority: 2, slots: [CS, numSlot('impactSpeed', 1)], render: (s) => `${s[0]} SLAMS IT · ${s[1]} M/S` },
  { kind: 'impact', intensity: 'normal', priority: 2, slots: [CS, numSlot('impactSpeed', 1)], render: (s) => `${s[0]} HAMMERS THE FLOOR · ${s[1]} M/S` },
  { kind: 'impact', intensity: 'hype', priority: 2, slots: [CS, numSlot('impactSpeed', 1)], render: (s) => `MASSIVE IMPACT · ${s[0]} · ${s[1]} M/S!` },

  // --- streak (num = streakCount) ----------------------------------------
  { kind: 'streak', intensity: 'calm', priority: 2, slots: [CS, numSlot('streakCount', 0)], render: (s) => `${s[0]} — ${s[1]} IN A ROW` },
  { kind: 'streak', intensity: 'normal', priority: 1, slots: [CS, numSlot('streakCount', 0)], render: (s) => `${s[0]} — THAT'S ${s[1]} STRAIGHT!` },
  { kind: 'streak', intensity: 'hype', priority: 1, slots: [CS, numSlot('streakCount', 0)], render: (s) => `${s[0]} IS ON FIRE · ${s[1]} STRAIGHT!` },

  // --- record (num = recordSpeed) — superlatives, priority 1 -------------
  { kind: 'record', intensity: 'calm', priority: 1, slots: [CS, numSlot('recordSpeed', 1)], render: (s) => `FASTEST THROW TODAY · ${s[0]} · ${s[1]}` },
  { kind: 'record', intensity: 'normal', priority: 1, slots: [CS, numSlot('recordSpeed', 1)], render: (s) => `NEW RECORD! ${s[0]} · ${s[1]} M/S` },
  { kind: 'record', intensity: 'hype', priority: 1, slots: [CS, numSlot('recordSpeed', 1)], render: (s) => `TOP OF THE DAY · ${s[0]} · ${s[1]} M/S!` },

  // --- shapeRain (num = spawnCount) --------------------------------------
  { kind: 'shapeRain', intensity: 'calm', priority: 3, slots: [numSlot('spawnCount', 0)], render: (s) => `${s[0]} NEW SHAPES DROP IN` },
  { kind: 'shapeRain', intensity: 'normal', priority: 2, slots: [numSlot('spawnCount', 0)], render: (s) => `SHAPE STORM · ${s[0]} INCOMING` },
  { kind: 'shapeRain', intensity: 'hype', priority: 2, slots: [numSlot('spawnCount', 0)], render: (s) => `THE SKY OPENS · ${s[0]} SHAPES!` },

  // --- grabDuel ----------------------------------------------------------
  { kind: 'grabDuel', intensity: 'calm', priority: 3, slots: [CS], render: (s) => `${s[0]} CONTESTS THE GRAB` },
  { kind: 'grabDuel', intensity: 'normal', priority: 2, slots: [CS], render: (s) => `${s[0]} RIPS IT AWAY` },
  { kind: 'grabDuel', intensity: 'hype', priority: 2, slots: [CS], render: (s) => `TUG OF WAR · ${s[0]} WINS IT!` },

  // --- join --------------------------------------------------------------
  { kind: 'join', intensity: 'calm', priority: 3, slots: [CS], render: (s) => `${s[0]} JOINS THE WORLD` },
  { kind: 'join', intensity: 'normal', priority: 3, slots: [CS], render: (s) => `${s[0]} ENTERS THE ARENA` },
  { kind: 'join', intensity: 'hype', priority: 2, slots: [CS], render: (s) => `WELCOME ${s[0]} — LOCK IN!` },

  // --- arm (showpiece; single-authority allowed) — priority 1 ------------
  { kind: 'arm', intensity: 'calm', priority: 1, slots: [], render: () => `SHOWPIECE ARMED — STAND BY` },
  { kind: 'arm', intensity: 'normal', priority: 1, slots: [], render: () => `HERE IT COMES — BRACE` },
  { kind: 'arm', intensity: 'hype', priority: 1, slots: [], render: () => `LIGHTS UP — THIS IS IT!` },

  // --- endCard (showpiece end; num = catches) — priority 1 ---------------
  { kind: 'endCard', intensity: 'calm', priority: 1, slots: [CS, numSlot('catches', 0)], render: (s) => `TOP DEFENDER · ${s[0]} · ${s[1]}` },
  { kind: 'endCard', intensity: 'normal', priority: 1, slots: [CS, numSlot('catches', 0)], render: (s) => `${s[0]} HELD THE LINE · ${s[1]} CATCHES` },
  { kind: 'endCard', intensity: 'hype', priority: 1, slots: [CS, numSlot('catches', 0)], render: (s) => `${s[0]} — ${s[1]} CATCHES — LEGEND!` },
];

/** The frozen template table. Id = positional index (u16). NEVER reorder. */
export const CASTER_TEMPLATES: readonly CasterTemplate[] = Object.freeze(
  DEFS.map((d, i) => ({ id: i, ...d }))
);

/** Look up a template by its wire id (undefined if the id is unknown). */
export function casterTemplate(id: number): CasterTemplate | undefined {
  return CASTER_TEMPLATES[id];
}

/** The kinds that may emit while a showpiece owns the caption (spec §7.15). */
export const SHOWPIECE_CASTER_KINDS: ReadonlySet<CasterEventKind> = new Set<CasterEventKind>([
  'arm',
  'endCard',
]);

// ---------------------------------------------------------------------------
// The pure decision: casterLine(event, ctx, rng): CasterLine | null.
// ---------------------------------------------------------------------------

/** The CASTER_LINE payload (indices / fixed-point ONLY — never strings). */
export interface CasterLine {
  templateId: number;
  slots: CasterSlot[];
}

/** True iff `event` clears the SHARED significance floor (else SILENCE). */
export function isSignificant(event: CasterEvent): boolean {
  switch (event.kind) {
    case 'throw':
      return event.releaseVel >= CASTER_SCORER_CFG.minActivitySpeed;
    case 'impact':
      return event.impactSpeed >= CASTER_SCORER_CFG.minActivitySpeed;
    case 'shapeRain':
      return event.spawnCount >= CASTER_SCORER_CFG.shapeRainMin;
    case 'streak':
      return event.streakCount >= CASTER_STREAK_MIN;
    case 'record':
      // A superlative fires ONLY on a real record — the host beats the record
      // before building this event; a non-positive record is never significant.
      return event.recordSpeed > 0;
    // join / grabDuel / arm / endCard are significant by construction (the host
    // only builds them at the right moment).
    default:
      return true;
  }
}

/**
 * Decide a caster line for `event` under `ctx`, or SILENCE (null). PURE +
 * DETERMINISTIC given `rng`. The pipeline:
 *   1. significance gate (SILENCE by default) — reuses the shared scorer floor;
 *   2. phase hype ladder → the intensity tier;
 *   3. gather this (kind, intensity) group's templates NOT in `avoidTemplateIds`
 *      (the ~3-min no-repeat LRU) — empty group ⇒ SILENCE;
 *   4. pick one variant via `rng`, and bind its slots to the event's signals
 *      (label↔signal truth).
 */
export function casterLine(event: CasterEvent, ctx: CasterCtx, rng: Rng): CasterLine | null {
  if (!isSignificant(event)) return null;

  const intensity = intensityForPhase(ctx.phase);
  const avoid = ctx.avoidTemplateIds;

  // Candidate templates for this kind at the ladder-selected intensity.
  let group = CASTER_TEMPLATES.filter((t) => t.kind === event.kind && t.intensity === intensity);
  // The ladder degrades gracefully: if a kind has no variant at the selected
  // intensity, fall back to ANY intensity for that kind (quota unchanged).
  if (group.length === 0) group = CASTER_TEMPLATES.filter((t) => t.kind === event.kind);
  if (avoid) group = group.filter((t) => !avoid.has(t.id));
  if (group.length === 0) return null; // all recently used → SILENCE (no repeat)

  const pick = group[Math.min(group.length - 1, Math.floor(rng() * group.length))];
  const slots = bindSlots(pick, event);
  if (!slots) return null; // an un-encodable callsign (leading-zero/oversized) → SILENCE
  return { templateId: pick.id, slots };
}

/** Bind a template's declared slots to `event`'s signals (label↔signal truth). */
function bindSlots(t: CasterTemplate, event: CasterEvent): CasterSlot[] | null {
  const slots: CasterSlot[] = [];
  for (const spec of t.slots) {
    if (spec.type === 'callsign') {
      const who = eventCallsign(event);
      if (!who || !isEncodableCallsign(who)) return null;
      slots.push({ kind: 'callsign', who });
    } else {
      const value = signalValue(event, spec.signal);
      if (value === null) return null;
      slots.push({ kind: 'num', value });
    }
  }
  return slots;
}

/** The callsign a caller-facing event references (null for the roster-free ones). */
function eventCallsign(event: CasterEvent): CasterCallsign | null {
  return 'who' in event && event.who ? event.who : null;
}

/** Pull the value for a declared signal — the label↔signal binding contract. */
function signalValue(event: CasterEvent, signal: CasterSignal): number | null {
  switch (signal) {
    case 'releaseVel':
      return event.kind === 'throw' ? event.releaseVel : null;
    case 'impactSpeed':
      return event.kind === 'impact' ? event.impactSpeed : null;
    case 'streakCount':
      return event.kind === 'streak' ? event.streakCount : null;
    case 'recordSpeed':
      return event.kind === 'record' ? event.recordSpeed : null;
    case 'spawnCount':
      return event.kind === 'shapeRain' ? event.spawnCount : null;
    case 'catches':
      return event.kind === 'endCard' ? event.catches : null;
  }
}

// ---------------------------------------------------------------------------
// Callsign (de)serialization — self-contained, lossless, roster-free.
// ---------------------------------------------------------------------------

/** True iff a callsign reference round-trips losslessly through the wire (u8 suffix). */
export function isEncodableCallsign(who: CasterCallsign): boolean {
  if (who.wordIndex < 0 || who.wordIndex >= CURATED_WORDLIST.length) return false;
  if (!Number.isInteger(who.suffix) || who.suffix < 0 || who.suffix > CASTER_SUFFIX_MAX) return false;
  return true;
}

/**
 * Parse a "WORD-NN" callsign into a self-contained slot, or null if it cannot be
 * encoded LOSSLESSLY (a leading-zero 3-digit suffix, or a suffix past u8) — the
 * caster stays SILENT on it rather than mis-render (SILENCE default).
 */
export function parseCallsign(callsign: string): CasterCallsign | null {
  const m = /^([A-Z]{3,10})-(\d{2,3})$/.exec(callsign);
  if (!m) return null;
  const wordIndex = CURATED_WORDLIST.indexOf(m[1]);
  if (wordIndex < 0) return null;
  const suffix = Number(m[2]);
  if (suffix > CASTER_SUFFIX_MAX) return null;
  const who = { wordIndex, suffix };
  // Lossless guard: the renderer must reproduce the exact original string.
  if (renderCallsign(who) !== callsign) return null;
  return who;
}

/** Render a self-contained callsign slot to "VOLT-17" — WITHOUT a roster. */
export function renderCallsign(who: CasterCallsign): string {
  const word = CURATED_WORDLIST[who.wordIndex] ?? 'PLAYER';
  return `${word}-${String(who.suffix).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Wire (de)serialization — flattened [tag, a, b] triples (spec Appendix B).
//   tag 0 = num       : a = round(value * SCALE) i32, b = 0
//   tag 1 = callsign  : a = wordIndex (u16 range), b = suffix (u8 range)
// The uniform 3-number triple keeps the golden `slots: number[]` round-trip
// exact; the codec in opcodes.ts packs a=i32 / b=i16.
// ---------------------------------------------------------------------------

/** Slot tag bytes (mirror the opcodes.ts CASTER_LINE codec). */
export const CASTER_SLOT_TAG = { NUM: 0, CALLSIGN: 1 } as const;

/** Serialize resolved slots to the flat [tag,a,b,…] wire array (indices/ints only). */
export function casterSlotsToWire(slots: readonly CasterSlot[]): number[] {
  const out: number[] = [];
  for (const s of slots) {
    if (s.kind === 'num') {
      out.push(CASTER_SLOT_TAG.NUM, Math.round(s.value * CASTER_FIXED_SCALE), 0);
    } else {
      out.push(CASTER_SLOT_TAG.CALLSIGN, s.who.wordIndex, s.who.suffix);
    }
  }
  return out;
}

/** Deserialize the flat [tag,a,b,…] wire array back to resolved slots. */
export function wireToCasterSlots(flat: readonly number[]): CasterSlot[] {
  const out: CasterSlot[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) {
    const tag = flat[i];
    const a = flat[i + 1];
    const b = flat[i + 2];
    if (tag === CASTER_SLOT_TAG.CALLSIGN) {
      out.push({ kind: 'callsign', who: { wordIndex: a, suffix: b } });
    } else {
      out.push({ kind: 'num', value: a / CASTER_FIXED_SCALE });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The CLIENT renderer — templateId + slots → text. Never generates a line; only
// resolves the authored template. Renders callsigns WITHOUT a roster.
// ---------------------------------------------------------------------------

/** Format one numeric slot for a template (decimals per the slot spec). */
function formatNum(value: number, decimals: 0 | 1): string {
  return decimals === 0 ? String(Math.round(value)) : value.toFixed(1);
}

/**
 * Render a CASTER_LINE to display text (the stage caption). Looks up the authored
 * template by id, resolves each slot (callsign from the wordlist index, number by
 * the template's decimals), and calls the template's render fn. Returns null for
 * an unknown template id or a slot/spec mismatch (the stage shows nothing rather
 * than a malformed line). NEVER generates copy — it only fills authored templates.
 */
export function renderCasterLine(templateId: number, slots: readonly CasterSlot[]): string | null {
  const t = casterTemplate(templateId);
  if (!t || slots.length !== t.slots.length) return null;
  const parts: string[] = [];
  for (let i = 0; i < t.slots.length; i++) {
    const spec = t.slots[i];
    const slot = slots[i];
    if (spec.type === 'callsign') {
      if (slot.kind !== 'callsign') return null;
      parts.push(renderCallsign(slot.who));
    } else {
      if (slot.kind !== 'num') return null;
      parts.push(formatNum(slot.value, spec.decimals));
    }
  }
  return t.render(parts);
}

/** Render straight from the flat wire array (the client's decode path). */
export function renderCasterWire(templateId: number, flat: readonly number[]): string | null {
  return renderCasterLine(templateId, wireToCasterSlots(flat));
}

/**
 * True iff `text` fits the 5-metre legibility budget (≤ {@link CASTER_MAX_LINES}
 * lines, each ≤ {@link CASTER_LINE_CHAR_BUDGET} chars). The template-budget test
 * asserts this for every template with representative slots.
 */
export function withinCasterBudget(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length > CASTER_MAX_LINES) return false;
  return lines.every((l) => l.length <= CASTER_LINE_CHAR_BUDGET);
}

export const SHARED_OK = true;

export * from './types.js';
export * from './constants.js';
export * from './shapeMath.js';
export * from './physicsCore.js';
export * from './net/types.js';
export * from './net/protocol.js';
// Phase C (Task C1) — opcode registry, tiers, callsigns, injected timers.
export * from './protocol/opcodes.js';
export * from './tiers.js';
export * from './callsigns.js';
export * from './timers.js';
// Phase C (Task C3) — clock sync + fire-at scheduler.
export * from './clock.js';
// Phase C (Task C5) — cue engine + RoomTimeline + PHASE_DURATIONS_MS + pacing table.
export * from './cues.js';
// Phase C (Task C9) — F1 Neon Director shot brain (pure) + RoomEvent (binding 14).
export * from './stageBrain.js';
// Phase C (Task C11) — F3 Reality Dials: ENV_STATE + cue-banner text derivation.
export * from './env.js';
// Phase C (Task C27) — F16 Siege Waves: the escalating wave table + budget model
// (the sibling module — Tier 6 residue-free; siege.ts only imports from here).
export * from './siegeWaves.js';
// Phase C (Task C28) — F17 Daemon Crew: pure behavior chassis + pose-synth (spec §7.17).
export * from './daemons.js';
// Phase C (Task C12) — F13 Neon Guestbook: pure glyph helpers (resample/validate/spiral).
export * from './glyphs.js';
// Phase C (Task C13) — F10 Ghost Arcade: pure reel model + coalescer + replay reducer.
export * from './reels.js';
// Phase C (Task C13) — the pure logical-BPM beat clock (attract choreography; C18 extends).
export * from './music/beatClock.js';
// Phase C (Task C18) — F8 Resonora pure core: noteMap, quantizer, conductor math.
export * from './music/noteMap.js';
export * from './music/quantizer.js';
export * from './music/conductorCore.js';
// Phase C (Task C14) — F4 Wisp Protocol: pure slot allocator + pulse rate/clamp.
export * from './wisps.js';
// Phase C (Task C15) — F5 Reality Referendum: pure election reducer (dial-id options).
export * from './elections.js';
// Phase C (Task C17) — F7 Titan Protocol: pure hand-impulse / clamp / recall / rig-scale math.
export * from './titanMath.js';
// Phase C (Task C32) — F21 Powers Lab: pure telekinesis pull-force / cone-select /
// sustained-hold / dead-man / clamps. All TK math lives here (residue-free cut).
export * from './tkMath.js';
// Phase C (Task C19) — F12 Supernova Encore pure core: charge normalization,
// per-phone tap debounce, seeded arp, ambient phase offsets, CROWD_CUE/CHARGE builders.
export * from './encore.js';
// Phase C (Task C20) — F9 Reality Channels: the PURE ThemeDef table + helpers +
// theme→election-option registration + the "N REALITIES …" stage line.
export * from './themes.js';
// Phase C (Task C21) — F11 Chrono Snap: the PURE ~30 s ring buffer + replay
// player + micro-resim parity core (the highlight scorer is the SINGLE-SOURCE
// one in stageBrain.ts, re-exported through replay.ts).
export * from './replay.js';

// Phase C (Task C26) — F15 MC NULL: the PURE procedural caster grammar + authored
// template table + phase hype ladder + self-contained callsign slots + the
// CASTER_LINE wire (de)serialization + the client-side text renderer.
export * from './casterGrammar.js';

// Phase C (Task C34) — F23 The Workshop: the PURE layout schema + validateLayout
// (cap-checked, cross-constant) + the deterministic settleBake (strips
// wind/freeze/attractors) the server bakes a saved / baseline composition with.
export * from './layouts.js';

/**
 * serverWorld.ts — Pure, Three-free authoritative world for the server.
 *
 * Manages a list of NetShape objects, applies physicsCore.stepBody each tick,
 * and enforces grab arbitration (first-claim-wins).
 *
 * NO Three.js imports. No Math.random() at module scope.
 */

import {
  type NetShape,
  type Vec3,
  type ShapeType,
  type RenderMode,
  stepBody,
  type PhysicsBody,
  type PhysicsParams,
  DEFAULT_PARAMS,
  clampScale,
  isFiniteVec3,
  isFiniteNumber,
} from '@cyber-shapes/shared';

export interface ServerWorldOpts {
  maxShapes: number;
  idFactory: () => string;
}

export class ServerWorld {
  private readonly _maxShapes: number;
  private readonly _idFactory: () => string;
  private _shapes: NetShape[] = [];
  /** Internal counter used to seed bobPhase/rotSpeed deterministically when not provided. */
  private _spawnCounter = 0;
  /**
   * Task C5 — §6.4 eviction invariant. Ids of PINNED bodies (Encore orb, siege
   * crystal, TK-pulled / timeline-critical shapes). A pinned body is NEVER evicted
   * by the `maxShapes` recycle-oldest cap — the eviction picks the oldest shape
   * that is BOTH ungrabbed AND unpinned. C10 (shape-rain) and C16 (siege) EXERCISE
   * this invariant via `pin()`/`unpin()`; they never re-implement it (spec §6.4).
   *
   * A Set of ids (not a per-shape flag) so a pin survives independently of the
   * NetShape object churn, and so `pin()` may be called before/after a spawn.
   */
  private readonly _pinned = new Set<string>();

  constructor(opts: ServerWorldOpts) {
    this._maxShapes = opts.maxShapes;
    this._idFactory = opts.idFactory;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get shapes(): NetShape[] {
    return this._shapes;
  }

  get(id: string): NetShape | undefined {
    return this._shapes.find((s) => s.id === id);
  }

  // ---------------------------------------------------------------------------
  // spawn
  // ---------------------------------------------------------------------------

  /**
   * Spawn a shape. Returns the new shape plus the id of any shape evicted to
   * stay within maxShapes (finding #8 — the caller MUST broadcast a despawn for
   * `evictedId`, else peers keep a ghost of the evicted shape forever), or
   * `null` if the spawn is rejected.
   *
   * Validation (findings #2/#5): consistent with its sibling mutators
   * (release/setHeld reject on non-finite), spawn now REJECTS (returns null) when
   * `position` is not a finite Vec3, or when the OPTIONAL `scale`/`bobPhase`
   * (finite number) / `rotSpeed` (finite Vec3) are present-but-non-finite. A
   * `1e999` in rotSpeed parses to Infinity (valid JSON) and would otherwise make
   * `step()` broadcast a non-finite rotation at 15Hz forever + persist it. The
   * connection-layer validateClientMsg is the real gate; this is the internal
   * belt-and-suspenders so a direct/programmatic caller can't poison the world.
   */
  spawn(init: {
    type: ShapeType;
    position: Vec3;
    colorIndex?: number;
    renderMode?: RenderMode;
    scale?: number;
    bobPhase?: number;
    rotSpeed?: Vec3;
  }): { shape: NetShape; evictedId: string | null } | null {
    // Reject non-finite inputs rather than silently substituting defaults, so
    // the internal path is coherent with release()/setHeld() (which reject).
    if (!isFiniteVec3(init.position)) return null;
    if (init.scale !== undefined && !isFiniteNumber(init.scale)) return null;
    if (init.bobPhase !== undefined && !isFiniteNumber(init.bobPhase)) return null;
    if (init.rotSpeed !== undefined && !isFiniteVec3(init.rotSpeed)) return null;

    const counter = ++this._spawnCounter;

    // Deterministic defaults derived from spawn counter (no Math.random at module scope)
    const defaultBobPhase = (counter * 1.23456789) % (2 * Math.PI);
    const defaultRotSpeed: Vec3 = {
      x: ((counter * 0.31) % 1.0) * 0.5,
      y: ((counter * 0.53) % 1.0) * 0.5,
      z: ((counter * 0.71) % 1.0) * 0.5,
    };

    const shape: NetShape = {
      id: this._idFactory(),
      type: init.type,
      colorIndex: init.colorIndex ?? 0,
      renderMode: init.renderMode ?? 'both',
      scale: init.scale ?? 1,
      grabbedBy: null,
      grounded: false,
      bobPhase: init.bobPhase ?? defaultBobPhase,
      rotSpeed: init.rotSpeed ? { ...init.rotSpeed } : defaultRotSpeed,
      position: { ...init.position },
      velocity: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    };

    // Enforce maxShapes by evicting the oldest shape that is BOTH UNGRABBED and
    // UNPINNED (§6.4 store-level eviction invariant, C5). Never evict:
    //   • a shape a peer is currently holding — eviction of a held object would
    //     make its held/release intents no-ops (the original Phase B finding); and
    //   • a system-PINNED body (Encore orb, siege crystal, TK-pulled shape) — a
    //     meteor storm must never despawn the crystal or a defender's held shape.
    // If EVERY existing shape is grabbed-or-pinned (edge), fall back to evicting
    // the oldest UNPINNED shape; if even that is empty (all pinned), evict nothing
    // and let the world briefly exceed the cap rather than despawn a pinned body —
    // a pinned body is explicitly protected. Report the evicted id so the caller
    // can broadcast a despawn (finding #8; preserved for the unpinned path).
    let evictedId: string | null = null;
    if (this._shapes.length >= this._maxShapes) {
      // Prefer the oldest ungrabbed AND unpinned shape.
      let evictIdx = this._shapes.findIndex(
        (s) => s.grabbedBy === null && !this._pinned.has(s.id)
      );
      // Fallback: oldest UNPINNED shape (even if grabbed) — still never a pin.
      if (evictIdx === -1) {
        evictIdx = this._shapes.findIndex((s) => !this._pinned.has(s.id));
      }
      if (evictIdx !== -1) {
        const [evicted] = this._shapes.splice(evictIdx, 1);
        if (evicted) evictedId = evicted.id;
      }
      // else: all shapes are pinned → evict nothing (never despawn a pin).
    }

    this._shapes.push(shape);
    return { shape, evictedId };
  }

  // ---------------------------------------------------------------------------
  // restore — repopulate world from persisted NetShapes WITHOUT re-assigning ids
  // ---------------------------------------------------------------------------

  /**
   * Restore shapes verbatim from a persisted snapshot.
   * Ids are kept stable (no idFactory calls). Existing shapes are cleared first.
   * Respects maxShapes by capping to the last maxShapes entries.
   *
   * Finding #9 validation (dropping malformed persisted shapes) lives SOLELY in
   * `RoomPersistence.load` — the disk boundary. By the time shapes reach here
   * they are already structurally valid, so we do NOT re-filter (the previous
   * second filter here was redundant with load's).
   */
  restore(shapes: NetShape[]): void {
    // Pins are transient runtime showpiece state, NEVER persisted (§6.4: showpiece
    // forces are never captured mid-flight). A restore rebuilds the world from
    // disk, so clear any stale pins — the restored bodies start unpinned.
    this._pinned.clear();
    // Clamp to maxShapes (take latest entries)
    const clamped =
      shapes.length <= this._maxShapes ? shapes : shapes.slice(shapes.length - this._maxShapes);
    // Deep-copy the Vec3 fields so a caller passing live objects can't alias
    // the world (mutating the input after restore must not affect our shapes).
    this._shapes = clamped.map((s) => ({
      ...s,
      position: { ...s.position },
      rotation: { ...s.rotation },
      velocity: { ...s.velocity },
      rotSpeed: { ...s.rotSpeed },
    }));
  }

  // ---------------------------------------------------------------------------
  // remove
  // ---------------------------------------------------------------------------

  remove(id: string): void {
    this._shapes = this._shapes.filter((s) => s.id !== id);
    // A removed shape's pin is meaningless — clear it so a recycled id can't
    // inherit a stale pin (ids are room-unique + monotonic, but stay defensive).
    this._pinned.delete(id);
  }

  // ---------------------------------------------------------------------------
  // pin / unpin — §6.4 eviction invariant (Task C5)
  // ---------------------------------------------------------------------------

  /**
   * Pin a shape so the `maxShapes` recycle-oldest cap NEVER evicts it (§6.4).
   * Idempotent; pinning an absent id is allowed (the pin applies if/when that id
   * is later present — but callers pin AFTER spawning the protected body). Used
   * for the Encore orb, the siege crystal (server-pinned), and TK-pulled shapes.
   */
  pin(id: string): void {
    this._pinned.add(id);
  }

  /** Un-pin a shape, re-exposing it to eviction (§6.4). Idempotent. */
  unpin(id: string): void {
    this._pinned.delete(id);
  }

  /** True iff `id` is currently pinned (exposed for tests / the RoomHandle). */
  isPinned(id: string): boolean {
    return this._pinned.has(id);
  }

  // ---------------------------------------------------------------------------
  // Mutation helpers
  // ---------------------------------------------------------------------------

  /** Returns false (no-op) if the shape is absent (finding #18). */
  setColor(id: string, colorIndex: number): boolean {
    const shape = this.get(id);
    if (!shape) return false;
    shape.colorIndex = colorIndex;
    return true;
  }

  /** Returns false (no-op) if the shape is absent (finding #18). */
  setRenderMode(id: string, mode: RenderMode): boolean {
    const shape = this.get(id);
    if (!shape) return false;
    shape.renderMode = mode;
    return true;
  }

  /** Returns false (no-op) if the shape is absent (finding #18). */
  setScale(id: string, scale: number): boolean {
    const shape = this.get(id);
    if (!shape) return false;
    shape.scale = clampScale(scale);
    return true;
  }

  // ---------------------------------------------------------------------------
  // grab / release / setHeld — grab arbitration
  // ---------------------------------------------------------------------------

  /**
   * First-claim-wins: returns false (no-op) if already grabbed by a DIFFERENT peer.
   * Sets grabbedBy + grounded=false on success.
   */
  grab(id: string, peerId: string): boolean {
    const shape = this.get(id);
    if (!shape) return false;
    // Already grabbed by a different peer: reject
    if (shape.grabbedBy !== null && shape.grabbedBy !== peerId) return false;
    shape.grabbedBy = peerId;
    shape.grounded = false;
    return true;
  }

  /**
   * Only the current owner can release. Writes velocity/position/rotation on success.
   */
  release(id: string, peerId: string, velocity: Vec3, position: Vec3, rotation: Vec3): boolean {
    const shape = this.get(id);
    if (!shape) return false;
    if (shape.grabbedBy !== peerId) return false;
    // Defensive (findings #2): reject non-finite transforms so a NaN can never
    // become an undespawnable ghost. Behind the connection-layer gate, but a
    // direct/programmatic call must not poison the world either.
    if (!isFiniteVec3(velocity) || !isFiniteVec3(position) || !isFiniteVec3(rotation)) {
      return false;
    }
    shape.grabbedBy = null;
    shape.velocity = { ...velocity };
    shape.position = { ...position };
    shape.rotation = { ...rotation };
    return true;
  }

  /**
   * Unconditionally clear a shape's grab (used on player departure/cleanup).
   *
   * Unlike release(), this does NOT validate the shape's transform: a departing
   * player's held shape may have a non-finite in-memory transform, and the
   * finite-Vec3 guard in release() would then return false and leave grabbedBy
   * pinned to the departed player, locking the shape forever (peers were already
   * told peerId:null). This nulls grabbedBy regardless. Returns true if the
   * shape existed and was grabbed by `peerId` (i.e. a grab was cleared).
   */
  forceRelease(id: string, peerId: string): boolean {
    const shape = this.get(id);
    if (!shape) return false;
    if (shape.grabbedBy !== peerId) return false;
    shape.grabbedBy = null;
    return true;
  }

  /**
   * Only the current owner can update transform while holding.
   */
  setHeld(id: string, peerId: string, position: Vec3, rotation: Vec3): boolean {
    const shape = this.get(id);
    if (!shape) return false;
    if (shape.grabbedBy !== peerId) return false;
    // Defensive (findings #2): reject non-finite transforms.
    if (!isFiniteVec3(position) || !isFiniteVec3(rotation)) return false;
    shape.position = { ...position };
    shape.rotation = { ...rotation };
    return true;
  }

  // ---------------------------------------------------------------------------
  // step — physics tick
  // ---------------------------------------------------------------------------

  /**
   * Advance the world by `dt`. `params` (C10 single-overlay host) is the effective
   * PhysicsParams the sim steps under — the merged base+overlay from the timeline
   * host. It DEFAULTS to DEFAULT_PARAMS so every existing caller (and Phase B
   * parity) is bit-identical: the default path executes stepBody's original
   * instruction sequence exactly (C6 parity goldens).
   */
  step(
    dt: number,
    params: PhysicsParams = DEFAULT_PARAMS
  ): { impacts: Array<{ id: string; speed: number }>; removed: string[] } {
    const impacts: Array<{ id: string; speed: number }> = [];
    const removed: string[] = [];

    for (const shape of this._shapes) {
      // Build a PhysicsBody view (mutable; we write back below)
      const body: PhysicsBody = {
        position: shape.position,
        velocity: shape.velocity,
        scale: shape.scale,
        type: shape.type,
        grabbedBy: shape.grabbedBy,
        grounded: shape.grounded,
      };

      const result = stepBody(body, dt, params);

      // Write back mutable physics state (stepBody mutated body.position/velocity/grounded in-place,
      // but we passed the same object references so they're already updated; write grounded explicitly)
      shape.grounded = body.grounded;

      // Advance rotation by rotSpeed*dt only when not grabbed
      if (shape.grabbedBy === null) {
        shape.rotation.x += shape.rotSpeed.x * dt;
        shape.rotation.y += shape.rotSpeed.y * dt;
        shape.rotation.z += shape.rotSpeed.z * dt;
      }

      if (result.impact) {
        impacts.push({ id: shape.id, speed: result.impactSpeed });
      }

      if (result.removed) {
        removed.push(shape.id);
      }
    }

    // Remove out-of-bounds shapes
    for (const id of removed) {
      this.remove(id);
    }

    return { impacts, removed };
  }
}

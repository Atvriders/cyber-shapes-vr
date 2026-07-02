/**
 * modeSelect.ts — pure mode-selection helpers for the client game loop (B6).
 *
 * PURE: no THREE, no DOM, no I/O, no Date/Math.random. Unit-tested in
 * test/modeSelect.test.ts.
 *
 * The client runs in one of two modes each frame:
 *   - OFFLINE (not connected): the Phase-A path is fully authoritative — local
 *     physics + full per-shape render update own every transform.
 *   - CONNECTED (server-driven): the server owns transforms. Each shape's
 *     transform this frame comes either from the server snapshot buffer
 *     ('remote') or, for the single shape this client is actively holding,
 *     from the local controller ('local') while we stream its 'held' pose up.
 */

/**
 * Decide where a shape's transform comes from this frame.
 *
 * @param shapeId        the shape being updated
 * @param locallyHeldId  the shape id this client is currently holding, or null
 * @param connected      whether the NetClient is connected to a server
 * @returns 'local' when offline, or when connected AND this shape is the one
 *          locally held; 'remote' otherwise (server-authoritative snapshot).
 */
export function chooseTransformSource(
  shapeId: string,
  locallyHeldId: string | null,
  connected: boolean
): 'local' | 'remote' {
  if (!connected) return 'local';
  return shapeId === locallyHeldId ? 'local' : 'remote';
}

/**
 * Set-based variant of {@link chooseTransformSource} (audit #14).
 *
 * VR can hold a shape in EACH hand, so the client may be locally driving more
 * than one shape at a time. This decides a shape's transform source against the
 * FULL set of locally-held ids: 'local' when offline, or when connected AND this
 * shape is in the held set; 'remote' otherwise.
 *
 * @param shapeId          the shape being updated
 * @param locallyHeldIds   the set of shape ids this client is currently holding
 * @param connected        whether the NetClient is connected to a server
 */
export function chooseTransformSourceMulti(
  shapeId: string,
  locallyHeldIds: ReadonlySet<string>,
  connected: boolean
): 'local' | 'remote' {
  if (!connected) return 'local';
  return locallyHeldIds.has(shapeId) ? 'local' : 'remote';
}

/**
 * Whether the client should run the SERVER-DRIVEN loop this frame (audit #22).
 *
 * The socket reaching OPEN is NOT sufficient: between OPEN and the server's
 * 'welcome' there are no server shapes yet, and if we suppress local physics on
 * OPEN alone the seeded/offline shapes freeze for that gap. We only hand
 * authority to the server once BOTH the socket is connected AND the welcome
 * (initial snapshot) has arrived; until then the offline path keeps running.
 *
 * @param connected        socket is OPEN
 * @param welcomeReceived  the server 'welcome' snapshot has arrived
 */
export function isServerDriven(connected: boolean, welcomeReceived: boolean): boolean {
  return connected && welcomeReceived;
}

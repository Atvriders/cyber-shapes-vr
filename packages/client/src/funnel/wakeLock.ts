/**
 * funnel/wakeLock.ts — Screen Wake Lock for the phone entries (spec §5.7 "Screen
 * Wake Lock on join").
 *
 * Keeps a phone's screen awake while it is an in-world participant so the display
 * doesn't sleep mid-rotation. Best-effort: the Wake Lock API is unsupported in
 * some in-app browsers, so every call degrades silently (never throws).
 *
 * ZERO DOM-construction, ZERO three — pure API wrapper, safe in the < 100 KB gz
 * ballot/crowd chunks.
 */

/** A minimal structural view of the Wake Lock API we depend on (testable). */
interface WakeLockSentinelLike {
  release(): Promise<void>;
}
interface WakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}
interface NavigatorWithWakeLock {
  wakeLock?: WakeLockApi;
}

/** A handle that releases the lock and stops re-acquiring it on visibility. */
export interface WakeLockHandle {
  release(): void;
}

/**
 * Acquire a screen wake lock (best-effort) and re-acquire it whenever the tab
 * returns to the foreground (Wake Lock is auto-released on `visibilitychange:
 * hidden`). Returns a handle whose `release()` tears it all down.
 *
 * @param nav  the navigator (injected for tests); defaults to globalThis.navigator
 * @param doc  the document (for visibilitychange); defaults to globalThis.document
 */
export function keepScreenAwake(
  nav: NavigatorWithWakeLock | undefined = (
    globalThis as unknown as { navigator?: NavigatorWithWakeLock }
  ).navigator,
  doc: Document | undefined = (globalThis as unknown as { document?: Document })
    .document
): WakeLockHandle {
  const wl = nav?.wakeLock;
  let sentinel: WakeLockSentinelLike | null = null;
  let released = false;

  const acquire = () => {
    if (released || !wl) return;
    wl.request('screen')
      .then((s) => {
        if (released) {
          void s.release().catch(() => {});
        } else {
          sentinel = s;
        }
      })
      .catch(() => {
        /* unsupported / denied — degrade silently */
      });
  };

  const onVisibility = () => {
    if (doc && doc.visibilityState === 'visible') acquire();
  };

  acquire();
  doc?.addEventListener('visibilitychange', onVisibility);

  return {
    release() {
      released = true;
      doc?.removeEventListener('visibilitychange', onVisibility);
      if (sentinel) {
        void sentinel.release().catch(() => {});
        sentinel = null;
      }
    },
  };
}

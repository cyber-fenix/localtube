// Whether a Google account is signed in, and therefore whether LocalTube
// should be writing anything.
//
// LocalTube is a signed-out YouTube account. While you are signed in, YouTube's
// own subscriptions, likes and history are in charge, and a second private set
// of them layered on top would be confusing at best — two Subscribe buttons
// disagreeing about whether you follow a channel, a like that goes nowhere.
// So LocalTube stands down: it keeps showing what it has, and stops writing.
//
// The state is published by the MAIN world (src/mainworld/ytdata.ts), which can
// read `ytcfg.LOGGED_IN`. Here we only read the attribute it sets.

const ATTR = 'localtubeSignedin'; // <- data-localtube-signedin

/** true / false, or null while the page has not said yet. */
export function signedIn(): boolean | null {
  const value = document.documentElement.dataset[ATTR];
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return null;
}

/**
 * Whether LocalTube may write.
 *
 * Unknown counts as signed out, deliberately. The two ways to be wrong are not
 * equal: assuming "signed in" while the page is still loading would blank the
 * whole extension on a page where it belongs, every single load. Assuming
 * "signed out" costs at most one click in the fraction of a second before
 * `ytcfg` is readable — and the things that write on a timer (history, resume)
 * need ten seconds of playback first, so they cannot fire inside that window.
 */
export function writesAllowed(): boolean {
  return signedIn() !== true;
}

/**
 * Call `cb` whenever the answer changes.
 *
 * Signing out in another tab does not reload this one, so the attribute is
 * watched rather than read once. The visibility check covers the case where the
 * change happened while this tab was in the background and the MAIN world's
 * poll had already stopped.
 */
export function onAccountChange(cb: (state: boolean | null) => void): void {
  let last = signedIn();
  const check = (): void => {
    const now = signedIn();
    if (now === last) return;
    last = now;
    cb(now);
  };
  new MutationObserver(check).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [`data-${ATTR.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`],
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
}

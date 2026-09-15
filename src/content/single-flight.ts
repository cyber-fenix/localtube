// One mount at a time.
//
// Every injected control is mounted from two places — route() on navigation and
// the self-healing observer in content/index.ts — and both can be inside the
// same mount at once, because a mount awaits its anchor and the page context
// before it inserts anything. In that window the control exists only as a
// detached node, so the second caller's `document.getElementById` check finds
// nothing and it builds a second copy. That is how the watch page ended up
// showing two Like buttons and two Dislikes inside one pill group.
//
// Wrapping a mount here makes concurrent callers share the in-flight run
// instead of racing it. The lock is released when the run settles, so the next
// navigation still mounts normally, and a caller that arrives while a mount is
// running gets that mount's promise rather than being dropped.

export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

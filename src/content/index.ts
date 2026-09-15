// Content-script entry point.
//
// YouTube is a single-page app: clicking a video swaps the page contents
// without a load, so everything here re-runs on every navigation and every
// mount is written to be idempotent. Getting that wrong is the classic YouTube
// extension bug — buttons that work after a reload and vanish (or double up)
// after a click.

import {
  anchor,
  diag,
  currentRoute,
  isFeedRoute,
  onNavigate,
  stopNavigationWatch,
} from '@/content/youtube-dom';
import { renderHome, unmountHome } from '@/content/home';
import { AVATAR_ID, closeMenu, mountMasthead } from '@/content/masthead';
import { CHANNELS_ID, mountNavRail, renderGuideChannels } from '@/content/nav-rail';
import { syncNativeSkin } from '@/content/native-skin';
import { mountQueue } from '@/content/queue';
import { mountSubscribeButton } from '@/content/subscribe-button';
import {
  closeChannelsPopover,
  mountSubscribeEverywhere,
  watchForSubscribeHosts,
} from '@/content/subscribe-anywhere';
import { ROW_ID, closePopover, mountVideoActions } from '@/content/video-actions';
import { nativeSkinOn } from '@/content/native-skin';
import { syncTheme, watchTheme } from '@/content/theme';
import { VIEW_CHANGED } from '@/ui/views';
import { ContextInvalidated, onDataChanged } from '@/lib/store';

async function route(): Promise<void> {
  // Cheap, and YouTube's theme can change without a navigation.
  syncTheme();
  // Must settle before the mounts: they style themselves according to whether
  // YouTube's own controls are hidden.
  await syncNativeSkin();

  if (isFeedRoute(currentRoute())) void renderHome();
  else unmountHome();

  // Each of these waits for its own anchor, so they run concurrently rather
  // than making the first slow one hold up the rest.
  await Promise.all([
    mountNavRail(),
    renderGuideChannels(),
    mountMasthead(),
    mountSubscribeButton(),
    mountSubscribeEverywhere(),
    mountVideoActions(),
    mountQueue(),
  ]);
}

/**
 * Remove everything LocalTube put on the page and stop all of its timers.
 *
 * Reached when the extension is reloaded, updated or disabled while this tab is
 * still open. The content script keeps running but its chrome.* APIs are dead,
 * so rather than throwing "Extension context invalidated" on every navigation
 * and every storage read, it takes its own UI down and goes quiet. Reloading
 * the tab brings back the new version.
 */
function teardown(): void {
  stopNavigationWatch();
  for (const el of Array.from(document.querySelectorAll('[id^="localtube-"], .lt-follow-anywhere')))
    el.remove();
  for (const el of Array.from(document.querySelectorAll('.localtube-active')))
    el.classList.remove('localtube-active');
  delete document.documentElement.dataset.localtubeNative;
  console.info('[LocalTube] extension reloaded — reload this tab to use the new version');
}

let stopped = false;

function run(): void {
  if (stopped) return;
  void route().catch((error) => {
    if (error instanceof ContextInvalidated) {
      stopped = true;
      teardown();
      return;
    }
    console.error('[LocalTube]', error);
  });
}

/**
 * Anything floating over the page belongs to the page you opened it on.
 *
 * These are appended to <body>, so YouTube's SPA navigation swaps the page out
 * from under them and leaves them hanging — the collaboration channel list was
 * still on screen after going back to the feed.
 *
 * Deliberately NOT called from route(): that also runs on a storage change, and
 * following a channel from inside the channel list is a storage change, which
 * would close the list mid-use.
 */
function closeOverlays(): void {
  closeChannelsPopover();
  closePopover();
  closeMenu();
}

/**
 * Put back anything YouTube has re-rendered away.
 *
 * YouTube reuses its containers and replaces their contents, and it does so
 * AFTER firing yt-navigate-finish — so a control mounted when that event
 * arrives is wiped moments later, with nothing to notice. Measured on a live
 * page: the action row mounts at 690ms into a navigation and is gone by 8s,
 * while the container element itself is never replaced.
 *
 * The subscribe buttons already survive this because their observer recreates
 * whatever is missing. These need the same treatment. Re-mounting only when the
 * node is actually absent keeps this from looping on our own insertions.
 */
function watchForMissingControls(): void {
  let queued = false;
  const check = (): void => {
    queued = false;
    if (stopped) return;
    if (currentRoute() === 'watch' && !document.getElementById(ROW_ID))
      void mountVideoActions().catch(() => undefined);
    if (nativeSkinOn() && !document.getElementById(AVATAR_ID))
      void mountMasthead().catch(() => undefined);
    // The guide is re-rendered on its own too, taking the channel list with it.
    if (anchor('guide') && !document.getElementById(CHANNELS_ID))
      void renderGuideChannels().catch(() => undefined);
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    window.setTimeout(check, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });
}

watchTheme();
watchForSubscribeHosts();
watchForMissingControls();
run();
onNavigate(() => {
  closeOverlays();
  run();
});
window.addEventListener(VIEW_CHANGED, closeOverlays);

// An edit made in the popup (or another tab) should be reflected here without a
// reload — a follow removed in the popup must not leave a stale "Following".
onDataChanged(() => run());

// Diagnostics for selector drift; see src/content/youtube-dom.ts.
(window as unknown as { __ltDiag: () => unknown }).__ltDiag = diag;

// One line on load, so "the buttons are missing" can be told apart from "the
// content script never ran" without any guesswork.
console.log('[LocalTube] content script loaded — run __ltDiag() to inspect anchors', diag());

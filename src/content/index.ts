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
import { extensionEnabled, onAccountChange, setExtensionEnabled } from '@/content/account';
import { watchCardChannelHarvest } from '@/content/avatar-harvest';
import { syncAccountBar } from '@/content/account-bar';
import { renderHome, unmountHome } from '@/content/home';
import { AVATAR_ID, closeMenu, mountMasthead } from '@/content/masthead';
import { BELL_ID, closeNotifications, mountBell } from '@/content/notifications';
import {
  CHANNELS_ID,
  SECTION_ID,
  dedupeGuideRules,
  mountNavRail,
  renderGuideChannels,
  renderGuideCounts,
} from '@/content/nav-rail';
import { syncNativeSkin } from '@/content/native-skin';
import { harvestChannelVideos, watchForHarvest } from '@/content/harvest';
import { mountHistory } from '@/content/history';
import { mountProgress } from '@/content/progress';
import { mountQueue } from '@/content/queue';
import { SAVE_PLAYLIST_ID, mountSavePlaylist } from '@/content/save-playlist';
import { mountSubscribeButton } from '@/content/subscribe-button';
import {
  closeChannelsPopover,
  mountSubscribeEverywhere,
  watchForSubscribeHosts,
} from '@/content/subscribe-anywhere';
import { ROW_ID, closePopover, mountVideoActions } from '@/content/video-actions';
import { closeCardMenu } from '@/ui/menu';
import { nativeSkinOn } from '@/content/native-skin';
import { syncTheme, watchTheme } from '@/content/theme';
import { VIEW_CHANGED } from '@/ui/views';
import { ContextInvalidated, getSettings, onDataChanged } from '@/lib/store';

/**
 * Remove every node LocalTube put on the page, and the flags that scope its
 * stylesheets. Shared by the disabled path and teardown() — the two cases
 * that both mean "make this page look like the extension isn't here."
 */
function clearInjectedUI(): void {
  unmountHome();
  for (const el of Array.from(
    document.querySelectorAll('[id^="localtube-"], .lt-follow-anywhere, .localtube-guide-entry, .lt-guide-rule'),
  ))
    el.remove();
  for (const el of Array.from(document.querySelectorAll('.localtube-active')))
    el.classList.remove('localtube-active');
  delete document.documentElement.dataset.localtubeNative;
  delete document.documentElement.dataset.localtubeBar;
}

async function route(): Promise<void> {
  // The master switch: checked before anything else touches the page, and
  // nothing below it assumes storage is even reachable yet. Stamped onto
  // <html> (see content/account.ts) so every independent mutation observer
  // in this file — the subscribe, harvest and avatar-harvest watchers — can
  // also stand down, not just this route.
  const enabled = (await getSettings()).enabled;
  setExtensionEnabled(enabled);
  if (!enabled) {
    clearInjectedUI();
    return;
  }

  // Cheap, and YouTube's theme can change without a navigation.
  syncTheme();
  // Must settle before the mounts: they style themselves according to whether
  // YouTube's own controls are hidden.
  await syncNativeSkin();
  // Same clock, so the bar and the gates can never disagree within a route.
  syncAccountBar();

  if (isFeedRoute(currentRoute())) void renderHome();
  else unmountHome();

  // Each of these waits for its own anchor, so they run concurrently rather
  // than making the first slow one hold up the rest.
  await Promise.all([
    mountNavRail(),
    renderGuideChannels(),
    // Cheap and write-free: one storage read, then a text node per row only
    // where the number actually changed. It runs on every route — which is
    // also every storage change — so the counts cannot go stale.
    renderGuideCounts(),
    mountMasthead(),
    mountBell(),
    mountSubscribeButton(),
    mountSavePlaylist(),
    mountSubscribeEverywhere(),
    mountVideoActions(),
    mountQueue(),
    mountHistory(),
    mountProgress(),
    harvestChannelVideos().then(() => undefined),
  ]);
  // Runs after both, regardless of which finished first — see
  // dedupeGuideRules() for why this can't be fixed inside either mount.
  dedupeGuideRules();
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
  // Two families: nodes keyed by a localtube- id, and cloned guide entries that
  // carry no id at all — a classname and the section rules beside them. The
  // clones are easy to forget here, and a missed one is a zombie: it keeps the
  // OLD script's styling and listeners alive in a tab the new script never
  // sees, so an extension reload looks like "nothing changed" until the tab is
  // reloaded.
  clearInjectedUI();
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
  closeCardMenu();
  closeNotifications();
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
    if (stopped || !extensionEnabled()) return;
    if (currentRoute() === 'watch' && !document.getElementById(ROW_ID))
      void mountVideoActions().catch(() => undefined);
    if (nativeSkinOn() && !document.getElementById(AVATAR_ID))
      void mountMasthead().catch(() => undefined);
    // Same treatment as the avatar: YouTube re-renders the masthead's button
    // row and takes the bell with it.
    if (nativeSkinOn() && !document.getElementById(BELL_ID))
      void mountBell().catch(() => undefined);
    // The playlist header is re-rendered the same way the watch actions are,
    // and it is the anchor our Save button is appended to.
    if (currentRoute() === 'playlist' && !document.getElementById(SAVE_PLAYLIST_ID))
      void mountSavePlaylist().catch(() => undefined);
    // The guide is re-rendered on its own too, taking both LocalTube groups
    // with it.
    if (anchor('guide') && !document.getElementById(CHANNELS_ID))
      void renderGuideChannels().then(dedupeGuideRules).catch(() => undefined);
    if (anchor('guide') && !document.getElementById(SECTION_ID))
      void mountNavRail().then(dedupeGuideRules).catch(() => undefined);
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    window.setTimeout(check, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });
}

watchTheme();
watchForSubscribeHosts();
watchForHarvest();
watchCardChannelHarvest();
watchForMissingControls();
run();
onNavigate(() => {
  closeOverlays();
  run();
});
window.addEventListener(VIEW_CHANGED, closeOverlays);

// An edit made in the popup (or another tab) should be reflected here without a
// reload — a follow removed in the popup must not leave a stale "Following".
//
// Trailing-debounced: route() rebuilds views wholesale, so a burst of storage
// writes — the card harvest noting avatars, a backfill learning handles —
// becomes ONE route at the end of the burst instead of a full re-render per
// write. Without this the import-aftershock measured as the feed rebuilding
// several times a second — "rapidly refreshing" — every hover dying with its
// card.
let runTimer = 0;
const runSoon = (): void => {
  window.clearTimeout(runTimer);
  runTimer = window.setTimeout(run, 350);
};
onDataChanged(runSoon);

// Signing in or out flips read-only mode without a reload: the whole route
// re-runs, so the skin lifts, the write controls come down (or come back), and
// history/progress recording stands down (or resumes).
onAccountChange(() => run());

// Diagnostics for selector drift; see src/content/youtube-dom.ts.
(window as unknown as { __ltDiag: () => unknown }).__ltDiag = diag;

// One line on load, so "the buttons are missing" can be told apart from "the
// content script never ran" without any guesswork.
console.log('[LocalTube] content script loaded — run __ltDiag() to inspect anchors', diag());

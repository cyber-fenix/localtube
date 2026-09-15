// EVERY YouTube selector lives here. YouTube's markup is undocumented and
// changes without notice; when LocalTube stops finding its anchors, the fix is
// almost always confined to this file. Run `__ltDiag()` in the page console to
// see which selectors currently match before changing any of them blind.
//
// Rule for the rest of the codebase: never read YouTube's own content. We only
// need mount points. That keeps the coupling to "does this container exist",
// which is far more stable than parsing YouTube's video cards.

/** First selector in the list that matches, or null. */
function pick(selectors: string[], root: ParentNode = document): HTMLElement | null {
  for (const sel of selectors) {
    const el = root.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

/** Anchors, in priority order. Earlier entries are the current markup; later
 *  ones are older layouts kept as a safety net. */
export const ANCHORS = {
  /** The home page's browse container — the one mount point the feed needs. */
  home: [
    'ytd-browse[page-subtype="home"]:not([hidden])',
    'ytd-browse[page-subtype="home"]',
    '#page-manager > ytd-browse:not([hidden])',
  ],
  /** The Subscriptions page's browse container. Same shape as home. */
  subscriptions: [
    'ytd-browse[page-subtype="subscriptions"]:not([hidden])',
    'ytd-browse[page-subtype="subscriptions"]',
    '#page-manager > ytd-browse:not([hidden])',
  ],
  /** Watch page: the row holding Like / Share / Download. */
  watchActions: [
    'ytd-watch-metadata #actions #top-level-buttons-computed',
    'ytd-watch-metadata #actions',
    '#top-level-buttons-computed',
    'ytd-watch-metadata #menu',
  ],
  /** Watch page: the channel owner block, next to YouTube's Subscribe. */
  watchOwner: ['ytd-watch-metadata #owner', '#owner', 'ytd-video-owner-renderer'],
  /** Channel page: the header area holding Subscribe. */
  channelHeader: [
    'yt-page-header-renderer yt-flexible-actions-view-model',
    'yt-page-header-renderer #page-header-banner ~ *',
    'ytd-channel-header-renderer #inner-header-container',
    '#channel-header #inner-header-container',
    'yt-page-header-renderer',
  ],
  /**
   * Full left sidebar, section list. NOTE: YouTube does not create
   * `ytd-guide-renderer` until the guide is first opened — on a fresh load only
   * `ytd-mini-guide-renderer` exists. See mountNavRail, which watches for it
   * rather than waiting a bounded time.
   */
  guide: ['ytd-guide-renderer #sections', 'ytd-guide-renderer #items', 'tp-yt-app-drawer #sections'],
  /** The player's <video>, used to auto-advance a LocalTube playlist. */
  video: ['video.html5-main-video', '#movie_player video', 'video'],
  /** Search-result channel row: the button strip beside the channel info. */
  searchChannelButtons: ['ytd-channel-renderer #buttons'],
  /** Masthead button strip, where the account avatar would sit. */
  masthead: ['ytd-masthead #end #buttons', 'ytd-masthead #buttons', '#masthead #end'],
} satisfies Record<string, string[]>;

/**
 * YouTube's own signed-out controls, hidden while the native skin is on.
 *
 * These are applied as ONE stylesheet rule rather than by finding nodes in
 * JavaScript: a CSS rule also covers nodes YouTube renders later, so there is
 * no mount race and nothing to re-run. The rules are scoped to
 * `html[data-localtube-native='hidden']`, so clearing that attribute restores
 * YouTube's page untouched.
 *
 * A selector that misses is benign — YouTube's button simply stays visible
 * alongside ours. `__ltDiag().hiding` reports which of these currently match,
 * which is how to find the ones that need updating.
 */
export const HIDE_SELECTORS: string[] = [
  // Subscribe, everywhere it appears. Hiding the renderer itself rather than
  // any wrapper matters: LocalTube's replacement is mounted as its sibling, so
  // hiding a container would take our own button with it — which is exactly how
  // the channel page lost its Subscribe button.
  'ytd-subscribe-button-renderer',
  // Channel page — Subscribe and Join. Verified against live markup: the page
  // header's action row is a plain `yt-flexible-actions-view-model` whose only
  // children ARE Subscribe and Join, and there is exactly one of them on the
  // page. None of YouTube's old ytd-subscribe-button-renderer / #subscribe-button
  // names exist here any more, which is why every earlier selector missed.
  //
  //   div#page-header > yt-page-header-renderer > yt-page-header-view-model
  //     > ... > yt-flexible-actions-view-model
  //       > div.ytFlexibleActionsViewModelAction > button-view-model > button
  // Hide the row's OWN children only. The row itself is our mount point (see
  // ANCHORS.channelHeader) — hiding it hid our button along with YouTube's,
  // which is why the channel page lost its Subscribe entirely.
  'yt-page-header-renderer yt-flexible-actions-view-model > *:not([id^="localtube-"])',
  '#page-header yt-flexible-actions-view-model > *:not([id^="localtube-"])',
  // Watch page — like / dislike (current view-model markup, then older)
  'ytd-watch-metadata segmented-like-dislike-button-view-model',
  'ytd-watch-metadata like-button-view-model',
  'ytd-watch-metadata dislike-button-view-model',
  '#top-level-buttons-computed ytd-toggle-button-renderer',
  '#top-level-buttons-computed ytd-segmented-like-dislike-button-renderer',
  // The player's own like/dislike, shown over the video in fullscreen. They sit
  // outside ytd-watch-metadata, so the selectors above do not reach them.
  'yt-player-quick-action-buttons like-button-view-model',
  'yt-player-quick-action-buttons dislike-button-view-model',
  // Watch page — Save to playlist
  'ytd-watch-metadata button[aria-label*="Save to playlist" i]',
  'ytd-watch-metadata yt-button-view-model:has(button[aria-label*="Save to playlist" i])',
  // Channel membership — "Join". Signed out it only ever opens a sign-in
  // prompt, and LocalTube has nothing to put in its place.
  // Every other Subscribe on the page — search results, channel shelves, hover
  // cards, the extra authors on a collaboration. Each is replaced by a LocalTube
  // button bound to that row's own channel (see content/subscribe-anywhere.ts).
  // Search results and channel shelves use a plain ytd-button-renderer inside a
  // wrapper instead of ytd-subscribe-button-renderer, so they need their own
  // rules. We mount into the surrounding strip, which stays visible.
  'ytd-channel-renderer #subscribe-button',
  'ytd-grid-channel-renderer #subscribe',

  // Watch page and content shelves. The channel header's Join is covered by the
  // flexible-actions rule above.
  '#sponsor-button',
  'ytd-watch-metadata #sponsor-button',
  // Masthead — Sign in. Matched by the link's destination rather than by
  // position, so the overflow and other masthead buttons are left alone.
  'ytd-masthead ytd-button-renderer:has(a[href*="accounts.google.com"])',
  'ytd-masthead yt-button-view-model:has(a[href*="accounts.google.com"])',
  'ytd-masthead #buttons a[href*="accounts.google.com"]',
  // Sidebar — "Sign in to like videos, comment, and subscribe"
  'ytd-guide-signin-promo-renderer',
  'ytd-mini-guide-renderer ytd-guide-signin-promo-renderer',
  // Sidebar — YouTube's signed-out "You" group and the History row beside it.
  // Both lead to a sign-in wall, and LocalTube's own section stands in for them
  // one group below; leaving them shows two History rows that do different
  // things. Matched by destination rather than by label, which is localised.
  // Signed out these are two plain entries; signed in, "You" is a collapsible
  // section. Both shapes are listed so the rule survives either.
  'ytd-guide-section-renderer > #items > ytd-guide-entry-renderer:has(a#endpoint[href="/feed/you"])',
  'ytd-guide-section-renderer > #items > ytd-guide-entry-renderer:has(a#endpoint[href="/feed/history"])',
  'ytd-guide-collapsible-section-entry-renderer:has(a#endpoint[href="/feed/you"])',
  // Under a video — the comment box's sign-in prompt
  '#comments ytd-comment-simplebox-renderer:has(a[href*="accounts.google.com"])',
  'ytd-comments-header-renderer yt-button-view-model:has(a[href*="accounts.google.com"])',
];

export type AnchorName = keyof typeof ANCHORS;

export function anchor(name: AnchorName): HTMLElement | null {
  return pick(ANCHORS[name]);
}

/* -------------------------------------------------------------------- routes */

export type Route = 'home' | 'subscriptions' | 'watch' | 'channel' | 'other';

/** Routes where LocalTube renders its own views in place of YouTube's. */
export const isFeedRoute = (route: Route): route is 'home' | 'subscriptions' =>
  route === 'home' || route === 'subscriptions';

export function currentRoute(): Route {
  const p = location.pathname;
  if (p === '/' || p === '') return 'home';
  if (p === '/feed/subscriptions') return 'subscriptions';
  if (p === '/watch') return 'watch';
  if (p.startsWith('/@') || p.startsWith('/channel/') || p.startsWith('/c/') || p.startsWith('/user/'))
    return 'channel';
  return 'other';
}

/** The video id of the watch page we are on, if any. */
export function currentVideoId(): string | null {
  if (currentRoute() !== 'watch') return null;
  return new URLSearchParams(location.search).get('v');
}

/**
 * True while an ad is playing.
 *
 * Load-bearing for anything that reads the player: during a pre-roll the
 * <video> element reports the AD's currentTime and duration, not the video's.
 * Recording that stored an ad's position against the real video, then resumed
 * into the ad — and when the ad finished, the video started from zero.
 *
 * YouTube marks the player itself, which is why this asks the player and not
 * the <video>: `.ad-showing` while an ad plays, `.ad-interrupting` around the
 * transition.
 */
export function adShowing(): boolean {
  const player = document.getElementById('movie_player');
  if (!player) return false;
  return player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
}

/* ---------------------------------------------------------------- navigation */

/**
 * Bumped on every navigation. A mount that awaits its anchor may resolve after
 * the user has already moved on; comparing the generation it started with tells
 * it to abandon the mount rather than inject into a page that is gone.
 */
let navGeneration = 0;

export function generation(): number {
  return navGeneration;
}

/**
 * YouTube is a single-page app: clicking a video swaps the DOM without a page
 * load, so anything mounted at document_idle is gone (or orphaned) a click
 * later. `yt-navigate-finish` is YouTube's own signal; the URL poll is the
 * safety net for the cases it does not fire (back/forward, some in-app links).
 *
 * This is the single most common source of "works on reload, not on click"
 * bugs in a YouTube extension, so it is deliberately belt-and-braces.
 */
let lastUrl = location.href;

/**
 * Tell the navigation watcher that a URL change was ours and is already
 * handled. LocalTube switches its own views with history.pushState — without
 * this the URL poll would notice the change and trigger a second, redundant
 * render a moment later.
 */
export function markUrlHandled(): void {
  lastUrl = location.href;
}

export function onNavigate(cb: () => void): void {
  const fire = (): void => {
    lastUrl = location.href;
    navGeneration++;
    cb();
  };

  window.addEventListener('yt-navigate-finish', fire);
  window.addEventListener('popstate', fire);
  window.addEventListener('hashchange', fire);

  // Poll as a backstop. 400ms is imperceptible to the user and costs nothing
  // measurable next to what the YouTube page itself is doing.
  navTimer = window.setInterval(() => {
    if (location.href !== lastUrl) fire();
  }, 400);
}

let navTimer: number | undefined;

/** Stop watching for navigation. Used when the extension context goes away. */
export function stopNavigationWatch(): void {
  if (navTimer !== undefined) window.clearInterval(navTimer);
  navTimer = undefined;
}

/**
 * Wait for an anchor to appear. YouTube renders its shell before its content,
 * so a mount attempted the instant navigation finishes usually finds nothing.
 */
export function waitForAnchor(name: AnchorName, timeoutMs = 10_000): Promise<HTMLElement | null> {
  const found = anchor(name);
  if (found) return Promise.resolve(found);

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const el = anchor(name);
      if (!el) return;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(el);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const timer = window.setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

/* --------------------------------------------------------------- diagnostics */

/** Exposed as `window.__ltDiag()` so selector drift can be diagnosed from the
 *  page console instead of guessed at. */
export function diag(): Record<string, unknown> {
  const anchors: Record<string, string | null> = {};
  for (const name of Object.keys(ANCHORS) as AnchorName[]) {
    const matched = ANCHORS[name].find((sel) => document.querySelector(sel));
    anchors[name] = matched ?? null;
  }
  // Which hide-selectors currently match something. A selector reported false
  // on a page where its target is visible is one that needs updating.
  const hiding: Record<string, number> = {};
  for (const sel of HIDE_SELECTORS) {
    try {
      hiding[sel] = document.querySelectorAll(sel).length;
    } catch {
      hiding[sel] = -1; // selector not supported by this browser
    }
  }

  return {
    route: currentRoute(),
    videoId: currentVideoId(),
    hash: location.hash,
    nativeSkin: document.documentElement.dataset.localtubeNative ?? null,
    // 'yes' / 'no' / null while the page has not said yet. Null on a loaded
    // page means the MAIN world could not read ytcfg — see mainworld/ytdata.ts.
    signedIn: document.documentElement.dataset.localtubeSignedin ?? null,
    adShowing: adShowing(),
    anchors,
    hiding,
    channelFromMainWorld: document.documentElement.dataset.localtubeChannel ?? null,
  };
}

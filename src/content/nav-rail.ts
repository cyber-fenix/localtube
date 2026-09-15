// LocalTube's entries in YouTube's left sidebar.
//
// These are not hand-built markup. YouTube's guide entries are Polymer elements
// with their own styling, and anything approximating them by hand looks close
// but wrong. Instead an existing entry is CLONED and repainted, which inherits
// the real geometry, hover states and theming for free.
//
// Two things that cost a while to learn, both verified in a live page:
//
//  - The clone is upgraded by Polymer when inserted, which re-renders it from
//    empty data and wipes whatever was set beforehand. So a clone is inserted
//    first and painted after, never the other way round.
//  - `yt-formatted-string`, `yt-icon` and `yt-img-shadow` keep re-rendering
//    themselves from that empty data on their own schedule, blanking their text
//    or re-hiding themselves minutes later. Every one of them is replaced with a
//    plain element carrying YouTube's classes and metrics, which Polymer leaves
//    alone. Painting them repeatedly instead does not work — it only shortens
//    the window in which they are right.

import { anchor, generation, waitForAnchor } from '@/content/youtube-dom';
import { writesAllowed } from '@/content/account';
import { singleFlight } from '@/content/single-flight';
import { listSubscriptions } from '@/lib/subscriptions';
import { getData, systemPlaylist } from '@/lib/store';
import { go, viewHash, type View } from '@/ui/views';
import { t } from '@/lib/i18n';

const ENTRY_CLASS = 'localtube-guide-entry';
export const SECTION_ID = 'localtube-guide-section';
export const CHANNELS_ID = 'localtube-guide-channels';

/** How many channels the sidebar shows before "Show more". */
const COLLAPSED = 7;
/** How many more channels one "Show more" press reveals. */
const PAGE_SIZE = 50;
/** How many channels are currently shown. Grows by PAGE_SIZE per press rather
 *  than jumping straight to "all" — a 300-channel Takeout import turned one
 *  click into a wall of rows otherwise. Resets to COLLAPSED once every channel
 *  is already shown and "Show less" is pressed. */
let shownCount = COLLAPSED;

const CHEVRON_RIGHT =
  'M8.793 5.293a1 1 0 000 1.414L14.086 12l-5.293 5.293a1 1 0 101.414 1.414L16.914 12l-6.707-6.707a1 1 0 00-1.414 0Z';
const CHEVRON_DOWN = 'M18.707 8.793a1 1 0 00-1.414 0L12 14.086 6.707 8.793a1 1 0 10-1.414 1.414L12 16.914l6.707-6.707a1 1 0 000-1.414Z';
const CHEVRON_UP = 'M5.293 15.207a1 1 0 001.414 0L12 9.914l5.293 5.293a1 1 0 101.414-1.414L12 7.086l-6.707 6.707a1 1 0 000 1.414Z';

interface EntrySpec {
  title: string;
  href?: string;
  avatar?: string;
  /** SVG path, for entries that use an icon rather than a channel avatar. */
  icon?: string;
  onClick?: () => void;
  /**
   * Render as a section header — the shape YouTube's own "You" row has: no
   * leading icon, a larger label, and a chevron. Signed in, that row is a
   * `ytd-guide-collapsible-section-entry-renderer`; a clone of a plain entry
   * plus these three differences is indistinguishable and far less fragile.
   */
  header?: boolean;
}

function svgIcon(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  svg.appendChild(node);
  return svg;
}

/** The entry LocalTube clones, and the row its channels are listed beneath. */
function subscriptionsEntry(): HTMLElement | null {
  const guide = anchor('guide');
  if (!guide) return null;
  const entries = Array.from(guide.querySelectorAll<HTMLElement>('ytd-guide-entry-renderer'));
  return (
    entries.find((e) => e.querySelector('a#endpoint')?.getAttribute('href') === '/feed/subscriptions') ??
    entries[0] ??
    null
  );
}

function paintEntry(entry: HTMLElement, spec: EntrySpec): void {
  const link = entry.querySelector('a#endpoint');
  if (link) {
    if (spec.href) link.setAttribute('href', spec.href);
    else link.removeAttribute('href');
    link.setAttribute('title', spec.title);
    link.removeAttribute('aria-label');
  }

  // yt-img-shadow re-hides itself, so the avatar is a plain <img> matching its
  // metrics exactly: 24x24, circular, 24px of trailing margin.
  const shadow = entry.querySelector('yt-img-shadow');
  if (shadow) shadow.remove();

  const icon = entry.querySelector('yt-icon.guide-icon, span.lt-guide-icon, img.lt-guide-avatar');
  if (icon) {
    if (spec.avatar) {
      // Idempotent: repaints run more than once, so an already-wright avatar is
      // left alone rather than swapped for an identical node (each replaceWith
      // is a pair of childList mutations that re-arms every observer watching
      // the guide).
      const already =
        icon instanceof HTMLImageElement && icon.getAttribute('src') === spec.avatar;
      if (!already) {
        const img = document.createElement('img');
        img.className = 'lt-guide-avatar';
        img.width = 24;
        img.height = 24;
        img.alt = '';
        img.loading = 'lazy';
        img.src = spec.avatar;
        icon.replaceWith(img);
      }
    } else if (spec.icon) {
      if (!(icon instanceof HTMLElement && icon.classList.contains('lt-guide-icon'))) {
        const span = document.createElement('span');
        span.className = 'guide-icon style-scope ytd-guide-entry-renderer lt-guide-icon';
        span.appendChild(svgIcon(spec.icon));
        icon.replaceWith(span);
      }
    } else {
      icon.setAttribute('hidden', '');
    }
  }

  // Same story for the label: yt-formatted-string blanks itself.
  const label = entry.querySelector('yt-formatted-string.title, span.lt-guide-title');
  if (label && label.textContent !== spec.title) {
    const span = document.createElement('span');
    span.className = 'title style-scope ytd-guide-entry-renderer lt-guide-title';
    span.textContent = spec.title;
    label.replaceWith(span);
  }

  // The header's chevron. Same substitution as everywhere else: the template's
  // own `yt-icon.arrow-icon` is Polymer-managed and re-hides itself.
  if (spec.header) {
    entry.dataset.ltHeader = '';
    const arrow = entry.querySelector('yt-icon.arrow-icon, span.lt-guide-arrow');
    if (!(arrow instanceof HTMLElement && arrow.classList.contains('lt-guide-arrow'))) {
      const span = document.createElement('span');
      span.className = 'arrow-icon style-scope ytd-guide-entry-renderer lt-guide-arrow';
      span.appendChild(svgIcon(CHEVRON_RIGHT));
      if (arrow) arrow.replaceWith(span);
      else entry.querySelector('tp-yt-paper-item')?.appendChild(span);
    }
  }
  // Clicks are intercepted at the window (see disarmPolymerGestures), so the
  // handler lives in a WeakMap there rather than as a per-entry listener.
}

/**
 * Keep YouTube's gesture recognizer away from cloned entries, and replace the
 * navigation it would have provided.
 *
 * Polymer upgrades our clones on insert and wires its own listeners to them,
 * but a clone carries none of the `data` those listeners expect. The live
 * stack from a channel-page click:
 *
 *   Cannot read properties of undefined (reading 'serviceEndpoint')
 *   at B.onTap … at Object.click … at Object._fire … | gestures._fire
 *
 * proves `tap` is synthesised from the native **click**, not only from the
 * down events. Worse for the user, the tap handler preventDefaults the real
 * navigation before it crashes — which is exactly "click, an error, nothing
 * happens." So the shield stops `click` too, and replaces what it took: an
 * entry with a click handler calls it here, an entry with only an href gets a
 * plain `location.assign`. That is a full page load rather than an SPA
 * transition — the same trade `openView` already makes for cross-page moves,
 * and the only navigation route that cannot crash inside Polymer again.
 *
 * Everything sits at `window` capture — the outermost point an event passes.
 * An earlier version listened on the clone itself and shipped broken: Polymer's
 * handlers sit on the SAME element, registered during upgrade before any
 * listener we can add to it, and listeners on one node fire in registration
 * order. At `window`, the event never reaches the clone on any upgrade timing.
 */
const clickHandlers = new WeakMap<HTMLElement, () => void>();
let gestureShieldInstalled = false;

function disarmPolymerGestures(): void {
  if (gestureShieldInstalled) return;
  gestureShieldInstalled = true;
  const cloneOf = (event: Event): HTMLElement | null => {
    for (const node of event.composedPath())
      if (node instanceof HTMLElement && node.classList.contains(ENTRY_CLASS)) return node;
    return null;
  };
  for (const type of ['pointerdown', 'mousedown', 'touchstart'])
    window.addEventListener(
      type,
      (event) => {
        if (cloneOf(event)) event.stopPropagation();
      },
      { capture: true },
    );
  window.addEventListener(
    'click',
    (event) => {
      const entry = cloneOf(event);
      if (!entry) return;
      event.preventDefault();
      event.stopPropagation();
      const handler = clickHandlers.get(entry);
      if (handler) {
        handler();
        return;
      }
      const href = entry.querySelector('a#endpoint')?.getAttribute('href');
      if (href) location.assign(href);
    },
    { capture: true },
  );
}

// Installed at module load, before the first clone exists: the shield has to
// be in place before any entry can be clicked, not just the ones built later.
disarmPolymerGestures();

/** Clone the template entry, insert after `after`, then paint it. */
function addEntry(template: HTMLElement, after: HTMLElement, spec: EntrySpec, tag: string): HTMLElement {
  const entry = template.cloneNode(true) as HTMLElement;
  entry.removeAttribute('id');
  entry.removeAttribute('is-primary');
  entry.setAttribute('line-end-style', 'none');
  entry.classList.add(ENTRY_CLASS);
  entry.dataset.ltEntry = tag;
  after.parentElement?.insertBefore(entry, after.nextSibling);
  // Inserted first: Polymer upgrades on insert and would undo an earlier paint.
  paintEntry(entry, spec);
  if (spec.onClick) clickHandlers.set(entry, spec.onClick);
  return entry;
}

/* ----------------------------------------------------------------- channels */

/**
 * The followed-channel list, directly beneath YouTube's own Subscriptions row,
 * which is where a signed-in account shows it.
 */
/**
 * Signature of what the sidebar currently shows. Rebuilding is deliberately
 * skipped when it already matches: every clone insert goes through Polymer's
 * upgrade machinery and each remove/add pair re-arms the mutation observer in
 * content/index.ts, which can escalate into a rebuild loop (observed on a live
 * page as the hover wash blinking several times per second and every click
 * landing on an entry that no longer existed). If YouTube genuinely re-renders
 * the guide, our entries simply vanish from the DOM and the count check below
 * notices — the signature alone is not trusted.
 */
let lastChannelSignature: string | null = null;

/**
 * Single-flighted (see content/single-flight.ts) because this has three
 * independent callers that can all fire within the same tick: route()'s
 * Promise.all on every navigation, watchForMissingControls()'s self-healing
 * observer in content/index.ts, and watchForGuide() below, which fires the
 * moment the guide first exists — on a cold reload with the guide already
 * open, that is exactly when the self-healing observer's own MutationObserver
 * also wakes up, since both watch the same subtree. Two unguarded calls
 * racing here means two independent reads of `lastChannelSignature` both
 * seeing "nothing built yet" and both inserting a full set of channel
 * clones — the same "two Like buttons" failure mode documented for the other
 * mounts, just never given the same guard.
 */
async function renderGuideChannelsOnce(): Promise<void> {
  // Signed in, the sidebar's channel list is the account's REAL one, rendered
  // by YouTube in the very slot we use when signed out — and its Polymer
  // renderer re-renders that list, deleting foreign children as it goes. Ours
  // either vanish or (worse) interleave with YouTube's, which shipped live as
  // "one LocalTube channel, then YouTube's list". LocalTube's channels simply
  // do not belong here while signed in: remove any that exist, and replace
  // them on sign-out via the normal path.
  if (!writesAllowed()) {
    for (const old of Array.from(
      document.querySelectorAll(`.${ENTRY_CLASS}[data-lt-entry="channel"], .lt-guide-rule[data-lt-rule="subs"]`),
    ))
      old.remove();
    document.getElementById(CHANNELS_ID)?.remove();
    lastChannelSignature = null;
    return;
  }

  const gen = generation();
  const subs = subscriptionsEntry();
  if (!subs) return;

  const channels = await listSubscriptions();
  if (gen !== generation()) return;

  const visibleCount = Math.min(shownCount, channels.length);
  const atEnd = visibleCount >= channels.length;
  const wanted = visibleCount + (channels.length > COLLAPSED ? 1 : 0);
  const signature = `${visibleCount}:${channels.map((c) => c.id).join(',')}`;
  const existing = document.querySelectorAll(`.${ENTRY_CLASS}[data-lt-entry="channel"]`);
  if (lastChannelSignature === signature && existing.length === wanted) {
    ensureChannelsMarker(subs);
    return;
  }
  lastChannelSignature = signature;

  for (const old of Array.from(existing)) old.remove();

  const shown = channels.slice(0, visibleCount);
  let after: HTMLElement = subs;
  const specs: [HTMLElement, EntrySpec][] = [];

  for (const channel of shown) {
    const spec: EntrySpec = {
      title: channel.title,
      href: `/channel/${channel.id}`,
      avatar: channel.avatar,
    };
    after = addEntry(subs, after, spec, 'channel');
    specs.push([after, spec]);
  }

  if (channels.length > COLLAPSED) {
    const spec: EntrySpec = {
      title: t(atEnd ? 'action_show_fewer' : 'action_show_more'),
      icon: atEnd ? CHEVRON_UP : CHEVRON_DOWN,
      onClick: () => {
        shownCount = atEnd ? COLLAPSED : Math.min(shownCount + PAGE_SIZE, channels.length);
        // The exported, single-flighted binding — not this module-internal
        // function — so a "Show more" click can't race a concurrent
        // self-healing rebuild any more than any other caller can.
        void renderGuideChannels();
      },
    };
    after = addEntry(subs, after, spec, 'channel');
    specs.push([after, spec]);
  }

  // Draw the group as its own section.
  //
  // When signed in, Subscriptions and its channels are a separate
  // ytd-guide-section-renderer, which is what puts a rule above and below them.
  // Cloning that element does not work — it gates its own #items on Polymer
  // data, so an emptied clone lays out at zero height. The rules are drawn as
  // plain siblings instead, matching the measured native section: 1px at 20%
  // with 12px either side.
  //
  // Only this function's own rules are cleared: the LocalTube section below
  // draws its own, and the two run concurrently from route().
  for (const old of Array.from(document.querySelectorAll('.lt-guide-rule[data-lt-rule="subs"]')))
    old.remove();
  if (shown.length > 0) {
    subs.parentElement?.insertBefore(rule('subs'), subs);
    const last = specs[specs.length - 1]?.[0] ?? after;
    last.parentElement?.insertBefore(rule('subs'), last.nextSibling);
  }

  // A marker so the self-healing observer in content/index.ts can tell "the
  // guide was re-rendered and took the channel list with it" from "there are
  // no channels to list" — without it, the check fires on every mutation.
  ensureChannelsMarker(subs);

  // One repaint shortly after insertion covers the upgrade; nothing painted here
  // is Polymer-managed any more, so it stays put after that.
  window.setTimeout(
    () => specs.forEach(([el, spec]) => el.isConnected && paintEntry(el, spec)),
    150,
  );
}

export const renderGuideChannels = singleFlight(renderGuideChannelsOnce);

/** A section rule, tagged with the section that owns it. */
function rule(owner: string): HTMLElement {
  const line = document.createElement('div');
  line.className = 'lt-guide-rule';
  line.dataset.ltRule = owner;
  return line;
}

/**
 * Collapse two adjacent rules into one.
 *
 * renderGuideChannels() draws a trailing rule after the channel list, and
 * mountNavRail() draws its own leading rule before the LocalTube section —
 * each one correct in isolation, each written without knowing about the
 * other. Whether they end up touching depends on whatever YouTube renders
 * between "Subscriptions" and the end of that guide section, which varies —
 * with nothing in between (the common case signed out), they land back to
 * back as a double line. The two mounts run concurrently from route()'s
 * Promise.all with no ordering guarantee, so the fix can't be "check before
 * inserting" in either one; it has to be a pass afterwards that looks at
 * what actually landed. Idempotent and cheap enough to call after every
 * route(), including ones that touched neither rule.
 *
 * "Adjacent" means visually, not in the DOM: YouTube's own signed-out "You"
 * and "History" entries (native-skin's HIDE_SELECTORS) commonly sit in the
 * DOM between these two rules, `display: none`. A plain
 * `previousElementSibling` check saw those hidden entries as real siblings
 * and never fired — the two rules rendered back to back on screen while the
 * DOM said they had content between them. `previousVisible` walks back past
 * anything that takes up no space, hidden natively or hidden by us.
 */
function previousVisible(el: Element): Element | null {
  let sibling = el.previousElementSibling;
  while (sibling && (sibling as HTMLElement).offsetParent === null) sibling = sibling.previousElementSibling;
  return sibling;
}

export function dedupeGuideRules(): void {
  for (const line of Array.from(document.querySelectorAll('.lt-guide-rule'))) {
    if (line.isConnected && previousVisible(line)?.classList.contains('lt-guide-rule')) {
      line.remove();
    }
  }
}

/**
 * Keep the sidebar's "you are here" highlight honest.
 *
 * `ytd-guide-entry-renderer[active]` is what YouTube itself uses for the grey
 * background + bold title on the current page (verified live, 2026-09-15: a
 * plain attribute selector, not something Polymer fights on a timer, so
 * setting it on our own clones gets the identical native look for free). It
 * is bound to the REAL url, which a LocalTube view never changes — so
 * switching from the feed to History left Home highlighted as if nothing had
 * happened, with nothing marking History as current instead.
 *
 * Called with the resolved View whenever content/home.ts actually renders
 * one, and with null when it tears its root down (content/home.ts's
 * unmountHome) — null only clears entries THIS module set, since at that
 * point the real page could be anything and restoring YouTube's own guess is
 * YouTube's job, not ours.
 */
export function syncGuideActiveState(view: View | null): void {
  const guide = anchor('guide');
  if (!guide) return;

  if (!view) {
    for (const entry of Array.from(guide.querySelectorAll(`.${ENTRY_CLASS}[active]`)))
      entry.removeAttribute('active');
    return;
  }

  const target =
    view.name === 'feed'
      ? guide.querySelector(`.${ENTRY_CLASS}[data-lt-header]`)
      : view.name === 'playlist'
        ? guide.querySelector(`.${ENTRY_CLASS}[data-lt-view="playlists"]`)
        : view.name === 'subscriptions'
          ? subscriptionsEntry()
          : guide.querySelector(`.${ENTRY_CLASS}[data-lt-view="${view.name}"]`);

  // Clear every OTHER active entry, native or ours — subscriptionsEntry() can
  // legitimately BE the target (on /feed/subscriptions, YouTube's own active
  // state already agrees with LocalTube's), and leaving that one alone is the
  // correct answer, not a bug this function should paper over.
  for (const entry of Array.from(guide.querySelectorAll('ytd-guide-entry-renderer[active]')))
    if (entry !== target) entry.removeAttribute('active');
  target?.setAttribute('active', '');
}

/** Insert the "channels were rendered here" marker if it is missing. */
function ensureChannelsMarker(subs: HTMLElement): void {
  if (document.getElementById(CHANNELS_ID)) return;
  const marker = document.createElement('div');
  marker.id = CHANNELS_ID;
  marker.hidden = true;
  subs.parentElement?.insertBefore(marker, subs);
}

/* ------------------------------------------------------- LocalTube's own section */

/**
 * The LocalTube section, built to the shape of YouTube's "You": a header row
 * with a chevron, then the account's own lists beneath it.
 *
 * The icons are YouTube's own paths, lifted from a signed-in guide, so History
 * and Watch later look like History and Watch later rather than like something
 * an extension drew.
 */
const ICONS = {
  localtube: 'M10 16.5v-9l6 4.5-6 4.5zM12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16z',
  history:
    'M8.76 1.487a11 11 0 11-7.54 12.706 1 1 0 011.96-.4 9 9 0 0014.254 5.38A9 9 0 0016.79 4.38 9 9 0 004.518 7H7a1 1 0 010 2H1V3a1 1 0 012 0v2.678a11 11 0 015.76-4.192ZM12 6a1 1 0 00-1 1v5.58l.504.288 3.5 2a1 1 0 10.992-1.736L13 11.42V7a1 1 0 00-1-1Z',
  playlists:
    'M16 15.395a.5.5 0 01.762-.426L22.5 18.5l-5.738 3.531a.5.5 0 01-.762-.425v-6.212ZM14 19H4a1 1 0 110-2h10v2Zm6-8a1 1 0 110 2H4a1 1 0 110-2h16Zm0-6a1 1 0 110 2H4a1 1 0 010-2h16Z',
  watchLater:
    'M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1Zm0 2a9 9 0 110 18.001A9 9 0 0112 3Zm0 3a1 1 0 00-1 1v5.565l.485.292 3.33 2a1 1 0 001.03-1.714L13 11.435V7a1 1 0 00-1-1Z',
  liked:
    'M9.221 1.795a1 1 0 011.109-.656l1.04.173a4 4 0 013.252 4.784L14 9h4.061a3.664 3.664 0 013.576 2.868A3.68 3.68 0 0121 14.85l.02.087A3.815 3.815 0 0120 18.5v.043l-.01.227a2.82 2.82 0 01-.135.663l-.106.282A3.754 3.754 0 0116.295 22h-3.606l-.392-.007a12.002 12.002 0 01-5.223-1.388l-.343-.189-.27-.154a2.005 2.005 0 00-.863-.26l-.13-.004H3.5a1.5 1.5 0 01-1.5-1.5V12.5A1.5 1.5 0 013.5 11h1.79l.157-.013a1 1 0 00.724-.512l.063-.145 2.987-8.535Zm-1.1 9.196A3 3 0 015.29 13H4v4.998h1.468a4 4 0 011.986.528l.27.155.285.157A10 10 0 0012.69 20h3.606c.754 0 1.424-.483 1.663-1.2l.03-.126a.819.819 0 00.012-.131v-.872l.587-.586c.388-.388.577-.927.523-1.465l-.038-.23-.02-.087-.21-.9.55-.744A1.663 1.663 0 0018.061 11H14a2.002 2.002 0 01-1.956-2.418l.623-2.904a2 2 0 00-1.626-2.392l-.21-.035-2.71 7.741Z',
} as const;

/** In YouTube's own order for the "You" section. */
const navLinks = (): [View, string, string][] => [
  [{ name: 'history' }, t('nav_history'), ICONS.history],
  [{ name: 'playlists' }, t('playlists_page_title'), ICONS.playlists],
  [{ name: 'watch-later' }, t('nav_watch_later'), ICONS.watchLater],
  [{ name: 'liked' }, t('nav_liked_videos'), ICONS.liked],
];

/** Open a LocalTube view from the sidebar, from wherever we currently are. */
function openView(view: View): void {
  // The views mount inside the home browse container, so anywhere else has to
  // navigate there first; on a feed route the hash change is enough.
  if (location.pathname === '/' || location.pathname === '/feed/subscriptions') go(view);
  else location.href = `/${viewHash(view)}`;
}

/**
 * LocalTube's own destinations, rendered as native entries so nothing in the
 * sidebar looks foreign. They sit below the followed channels, where a
 * signed-in account has "You".
 */
export async function mountNavRail(): Promise<void> {
  const gen = generation();
  let guide = anchor('guide');
  if (!guide) {
    guide = await waitForAnchor('guide', 4000);
    if (!guide) {
      watchForGuide();
      return;
    }
  }
  if (gen !== generation()) return;

  const subs = subscriptionsEntry();
  if (!subs) return;

  // Signed in, the entries' own list re-renders around the account's real
  // channel list and deletes foreign children on every pass — it ate this
  // section whole. Above the items list, though, each SECTION is a sibling,
  // and a block sitting among the sections only dies in a full-sections
  // rebuild, which is rare and which the self-healing observer restores. So
  // placement depends on the account state: positioned within the entries list
  // signed out, after the last whole section signed in.
  const signedInMode = !writesAllowed();
  const parent = signedInMode
    ? (subs.closest('ytd-guide-section-renderer')?.parentElement ?? subs.parentElement)
    : subs.parentElement;
  if (!parent) return;

  // A mode flip relocates the section: remove what the old placement left.
  const existing = document.getElementById(SECTION_ID);
  if (existing) {
    if ((existing.dataset.ltPlacement === 'end') === signedInMode) return;
    for (const old of Array.from(
      document.querySelectorAll(`.${ENTRY_CLASS}[data-lt-entry="link"], .lt-guide-rule[data-lt-rule="lt"]`),
    ))
      old.remove();
    existing.remove();
  }

  const marker = document.createElement('div');
  marker.id = SECTION_ID;
  marker.hidden = true;
  marker.dataset.ltPlacement = signedInMode ? 'end' : 'inline';
  parent.appendChild(marker);
  marker.parentElement?.insertBefore(rule('lt'), marker);

  const specs: [HTMLElement, EntrySpec][] = [];
  let after: HTMLElement = marker;

  const headerSpec: EntrySpec = {
    title: 'LocalTube',
    header: true,
    href: `/${viewHash({ name: 'feed' })}`,
    onClick: () => openView({ name: 'feed' }),
  };
  after = addEntry(subs, after, headerSpec, 'link');
  specs.push([after, headerSpec]);

  for (const [view, label, path] of navLinks()) {
    const spec: EntrySpec = {
      title: label,
      href: `/${viewHash(view)}`,
      icon: path,
      onClick: () => openView(view),
    };
    after = addEntry(subs, after, spec, 'link');
    // What this row counts. Read back by renderGuideCounts, which is the only
    // thing that ever writes a number here.
    after.dataset.ltView = view.name;
    specs.push([after, spec]);
  }

  // Signed out (inline placement), this block sits inside YouTube's own
  // "Home" ytd-guide-section-renderer — the same section holding
  // Home/Shorts/Subscriptions — and that section draws its OWN native
  // border-bottom around its whole box, LocalTube's tail included. Verified
  // live: the section's own computed border-bottom is 1px solid
  // rgba(0,0,0,.2), the exact rule this module draws by hand elsewhere, and
  // its box literally ends a few pixels below "Liked videos". Drawing our
  // own trailing rule there duplicated that native one — a second thin line
  // a few pixels under the first, easy to miss in isolation but exactly what
  // read as "double bar at the bottom" once both existed. Signed in ('end'
  // placement), this block is appended AFTER every native section instead,
  // where no such border exists to lean on, so it still needs its own.
  if (signedInMode) after.parentElement?.insertBefore(rule('lt'), after.nextSibling);

  window.setTimeout(
    () => specs.forEach(([el, spec]) => el.isConnected && paintEntry(el, spec)),
    150,
  );

  void renderGuideCounts();
}

/* -------------------------------------------------------------------- counts */

/**
 * How many things each LocalTube row leads to.
 *
 * Deliberately NOT part of `mountNavRail`'s build, and deliberately not part of
 * the channel signature either. Both exist to stop the sidebar being REBUILT,
 * and a count changes far more often than the rows do — every save to Watch
 * later, every video watched. Folding it into either one would mean a clone
 * remove/add storm on ordinary use (measured once at ~3,500 cycles in ten
 * seconds), and leaving it out of both would mean a number that goes stale the
 * moment you save anything.
 *
 * So the number is written on its own, into a node that already exists, by
 * setting a Text node's `data` — a characterData mutation, which the
 * self-healing observer in content/index.ts does not watch (it asks for
 * childList only). `textContent =` would replace the child and wake it on
 * every write.
 */
export async function renderGuideCounts(): Promise<void> {
  const entries = Array.from(
    document.querySelectorAll<HTMLElement>(`.${ENTRY_CLASS}[data-lt-view]`),
  );
  if (entries.length === 0) return;

  const data = await getData();
  const counts: Record<string, number> = {
    history: data.history.length,
    // User playlists only: Watch later and Liked have rows of their own, and
    // counting them here would count them twice.
    playlists: Object.values(data.playlists).filter((playlist) => !playlist.system).length,
    'watch-later': systemPlaylist(data, 'watch-later').videos.length,
    liked: systemPlaylist(data, 'liked').videos.length,
  };

  for (const entry of entries) setCount(entry, counts[entry.dataset.ltView ?? ''] ?? 0);
}

/**
 * Write one row's count into YouTube's own count slot.
 *
 * `span.guide-entry-count` is part of every guide entry — YouTube uses it for
 * the new-video count on Subscriptions when signed in — so the clone already
 * carries one, in the right place, at the right size. It is Polymer-managed
 * and `display: none` until Polymer fills it, so it gets the same treatment as
 * the label and the icon: replaced once with a plain span, then left alone.
 *
 * Zero shows nothing. An empty Watch later saying "0" is noise, and YouTube's
 * own count is absent rather than zero in the same situation.
 */
function setCount(entry: HTMLElement, count: number): void {
  const text = count > 0 ? String(count) : '';
  let slot = entry.querySelector<HTMLElement>('span.lt-guide-count');
  if (!slot) {
    const original = entry.querySelector('span.guide-entry-count');
    if (!original) return;
    slot = document.createElement('span');
    slot.className = 'guide-entry-count style-scope ytd-guide-entry-renderer lt-guide-count';
    slot.appendChild(document.createTextNode(''));
    original.replaceWith(slot);
  }
  const node = slot.firstChild;
  // .data, not .textContent: replacing the child is a childList mutation, and
  // the guide observer would wake on every count change.
  if (node instanceof Text) {
    if (node.data !== text) node.data = text;
  } else {
    slot.replaceChildren(document.createTextNode(text));
  }
}

/**
 * Watch for the guide indefinitely.
 *
 * A bounded wait is not enough: YouTube does not create `ytd-guide-renderer` at
 * all until the guide is first opened — on a fresh load only the collapsed
 * `ytd-mini-guide-renderer` exists.
 */
let watching = false;

function watchForGuide(): void {
  if (watching) return;
  watching = true;
  const observer = new MutationObserver(() => {
    if (!anchor('guide')) return;
    observer.disconnect();
    watching = false;
    void mountNavRail();
    void renderGuideChannels();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

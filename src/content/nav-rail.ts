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
import { listSubscriptions } from '@/lib/subscriptions';
import { go, viewHash, type View } from '@/ui/views';

const ENTRY_CLASS = 'localtube-guide-entry';
export const SECTION_ID = 'localtube-guide-section';
export const CHANNELS_ID = 'localtube-guide-channels';

/** How many channels the sidebar shows before "Show more". */
const COLLAPSED = 7;
let expanded = false;

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
      const img = document.createElement('img');
      img.className = 'lt-guide-avatar';
      img.width = 24;
      img.height = 24;
      img.alt = '';
      img.loading = 'lazy';
      img.src = spec.avatar;
      icon.replaceWith(img);
    } else if (spec.icon) {
      const span = document.createElement('span');
      span.className = 'guide-icon style-scope ytd-guide-entry-renderer lt-guide-icon';
      span.appendChild(svgIcon(spec.icon));
      icon.replaceWith(span);
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
    const span = document.createElement('span');
    span.className = 'arrow-icon style-scope ytd-guide-entry-renderer lt-guide-arrow';
    span.appendChild(svgIcon(CHEVRON_RIGHT));
    if (arrow) arrow.replaceWith(span);
    else entry.querySelector('tp-yt-paper-item')?.appendChild(span);
  }

  if (spec.onClick) {
    (entry as HTMLElement & { onclick: ((e: Event) => void) | null }).onclick = (event: Event) => {
      event.preventDefault();
      spec.onClick?.();
    };
  }
}

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
  return entry;
}

/* ----------------------------------------------------------------- channels */

/**
 * The followed-channel list, directly beneath YouTube's own Subscriptions row,
 * which is where a signed-in account shows it.
 */
export async function renderGuideChannels(): Promise<void> {
  const gen = generation();
  const subs = subscriptionsEntry();
  if (!subs) return;

  const channels = await listSubscriptions();
  if (gen !== generation()) return;

  for (const old of Array.from(document.querySelectorAll(`.${ENTRY_CLASS}[data-lt-entry="channel"]`)))
    old.remove();

  const shown = expanded ? channels : channels.slice(0, COLLAPSED);
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
      title: expanded ? 'Show fewer' : 'Show more',
      icon: expanded ? CHEVRON_UP : CHEVRON_DOWN,
      onClick: () => {
        expanded = !expanded;
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
  if (!document.getElementById(CHANNELS_ID)) {
    const marker = document.createElement('div');
    marker.id = CHANNELS_ID;
    marker.hidden = true;
    subs.parentElement?.insertBefore(marker, subs);
  }

  // One repaint shortly after insertion covers the upgrade; nothing painted here
  // is Polymer-managed any more, so it stays put after that.
  window.setTimeout(
    () => specs.forEach(([el, spec]) => el.isConnected && paintEntry(el, spec)),
    150,
  );
}

/** A section rule, tagged with the section that owns it. */
function rule(owner: string): HTMLElement {
  const line = document.createElement('div');
  line.className = 'lt-guide-rule';
  line.dataset.ltRule = owner;
  return line;
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
const LINKS: [View, string, string][] = [
  [{ name: 'history' }, 'History', ICONS.history],
  [{ name: 'playlists' }, 'Playlists', ICONS.playlists],
  [{ name: 'watch-later' }, 'Watch later', ICONS.watchLater],
  [{ name: 'liked' }, 'Liked videos', ICONS.liked],
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

  // Idempotent: rebuilt only when absent, so re-running does not duplicate.
  if (document.getElementById(SECTION_ID)) return;

  const marker = document.createElement('div');
  marker.id = SECTION_ID;
  marker.hidden = true;
  subs.parentElement?.appendChild(marker);
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

  for (const [view, label, path] of LINKS) {
    const spec: EntrySpec = {
      title: label,
      href: `/${viewHash(view)}`,
      icon: path,
      onClick: () => openView(view),
    };
    after = addEntry(subs, after, spec, 'link');
    specs.push([after, spec]);
  }

  after.parentElement?.insertBefore(rule('lt'), after.nextSibling);

  window.setTimeout(
    () => specs.forEach(([el, spec]) => el.isConnected && paintEntry(el, spec)),
    150,
  );
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

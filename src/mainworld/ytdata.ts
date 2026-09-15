// MAIN-world script. The isolated content script cannot see page JavaScript, and
// the channel id LocalTube keys everything on (`UC...`) is not reliably present
// in YouTube's DOM — modern pages link channels by @handle. It *is* present in
// `ytInitialPlayerResponse` / `ytInitialData`, so we read it here and bridge it
// to the isolated world through a <html> data attribute, the same two-world
// pattern Gmail Bulk Extractor uses for Gmail's `ik` token.

const ATTR = 'localtubeChannel'; // -> data-localtube-channel

interface Bridged {
  videoId?: string;
  videoTitle?: string;
  published?: string;
  thumbnail?: string;
  channelId?: string;
  channelTitle?: string;
  avatar?: string;
}

/** Depth-first search for the first object containing `key`. YouTube's response
 *  shapes move between releases; the key names have been far more stable than
 *  the paths to them. */
function deepFind(root: unknown, key: string, depth = 0): any {
  if (depth > 12 || root === null || typeof root !== 'object') return undefined;
  if (key in (root as Record<string, unknown>)) return (root as Record<string, unknown>)[key];
  for (const value of Object.values(root as Record<string, unknown>)) {
    const found = deepFind(value, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function biggestThumb(node: unknown): string | undefined {
  const thumbs = deepFind(node, 'thumbnails');
  if (!Array.isArray(thumbs) || thumbs.length === 0) return undefined;
  return thumbs[thumbs.length - 1]?.url as string | undefined;
}

/**
 * The current video's player response.
 *
 * `ytInitialPlayerResponse` is only set on a full page load: after an in-page
 * navigation it still describes the PREVIOUS video, which is why the watch-page
 * controls used to sit unmounted until their 8s wait expired. The player
 * element's own API always reflects what is actually playing.
 */
function playerResponse(): any {
  const player = document.getElementById('movie_player') as any;
  const live = player?.getPlayerResponse?.();
  if (live?.videoDetails) return live;
  return (window as any).ytInitialPlayerResponse;
}

function readWatch(): Bridged | null {
  const wanted = new URLSearchParams(location.search).get('v');
  const response = playerResponse();
  const details = response?.videoDetails;
  // Reject a stale payload left over from the previous video.
  if (!details?.channelId || (wanted && details.videoId !== wanted)) return null;

  const owner = deepFind((window as any).ytInitialData, 'videoOwnerRenderer');
  const microformat = response?.microformat?.playerMicroformatRenderer;
  return {
    videoId: details.videoId,
    videoTitle: details.title,
    published: microformat?.publishDate ?? undefined,
    thumbnail: biggestThumb(details.thumbnail) ?? `https://i.ytimg.com/vi/${details.videoId}/hqdefault.jpg`,
    channelId: details.channelId,
    channelTitle: details.author,
    avatar: owner ? biggestThumb(owner.thumbnail) : undefined,
  };
}

/** The channel id the current URL names, from the path or the canonical link.
 *  Used to reject a stale payload, so it must come from the page, not the data. */
function urlChannelId(): string | undefined {
  const fromPath = /\/channel\/(UC[\w-]{22})/.exec(location.pathname)?.[1];
  if (fromPath) return fromPath;
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? '';
  return /\/channel\/(UC[\w-]{22})/.exec(canonical)?.[1];
}

function readChannel(): Bridged | null {
  const meta = deepFind((window as any).ytInitialData, 'channelMetadataRenderer');
  if (!meta?.externalId) return null;
  // Same staleness rule as the watch page: after an in-page navigation
  // ytInitialData can still describe the channel you came FROM. Publishing that
  // would put the previous channel's name and follow state on this page.
  const wanted = urlChannelId();
  if (wanted && meta.externalId !== wanted) return null;
  return {
    channelId: meta.externalId,
    channelTitle: meta.title,
    avatar: biggestThumb(meta.avatar),
  };
}

function publish(): boolean {
  // Runs at document_start. Chrome creates <html> before content scripts run,
  // but a throw here would take the whole script down — including the channel
  // tagging below — so never assume it.
  const root = document.documentElement;
  if (!root) return false;

  const path = location.pathname;
  let data: Bridged | null = null;
  if (path === '/watch') data = readWatch();
  else if (/^\/(@|channel\/|c\/|user\/)/.test(path)) data = readChannel();

  if (!data?.channelId) {
    delete root.dataset[ATTR];
    return false;
  }
  root.dataset[ATTR] = JSON.stringify(data);
  return true;
}

/**
 * YouTube populates its data objects after navigation completes, so a single
 * read finds nothing. Poll briefly after each navigation and stop as soon as we
 * publish something usable.
 */
/* ------------------------------------------------------- channel id stamps */

/**
 * Tag every Subscribe control on the page with the channel it belongs to.
 *
 * A subscribe button anywhere outside the watch page — a search result, a
 * channel shelf, the second author on a collaboration, a hover card — links to
 * its channel only by @handle, and the `UC...` id lives on the element's
 * Polymer `data` property. An isolated-world content script cannot see page
 * JavaScript properties, so we read them here and stamp them onto the DOM,
 * where the content script can pick them up.
 *
 * This is what makes the replacement location-agnostic: LocalTube does not need
 * to know about each new place YouTube puts a Subscribe button, only that the
 * button carries a channel id.
 */
const HOSTS = [
  'ytd-subscribe-button-renderer',
  'ytd-channel-renderer',
  'ytd-grid-channel-renderer',
  'ytd-channel-about-metadata-renderer',
];

const CHANNEL_ID = /UC[\w-]{22}/g;

/**
 * Decode a `subscribedEntityKey`.
 *
 * Newer subscribe renderers carry no `channelId` at all — only this key, which
 * is base64url-encoded protobuf holding the channel id, or on a collaboration
 * several of them comma-separated. That is how a single Subscribe button can
 * subscribe to two channels at once, and it is the only place either id
 * appears: the DOM links only by @handle.
 */
function idsFromEntityKey(key: unknown): string[] {
  if (typeof key !== 'string') return [];
  try {
    let b64 = decodeURIComponent(key).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return [...new Set(atob(b64).match(CHANNEL_ID) ?? [])];
  } catch {
    return [];
  }
}

/** One channel behind a subscribe control. */
interface ChannelRef {
  id: string;
  title?: string;
  avatar?: string;
}

const isChannelId = (v: unknown): v is string => typeof v === 'string' && /^UC[\w-]{22}$/.test(v);

function textOf(node: any): string | undefined {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return undefined;
  if (typeof node.content === 'string') return node.content;
  if (typeof node.simpleText === 'string') return node.simpleText;
  const run = node.runs?.[0]?.text;
  return typeof run === 'string' ? run : undefined;
}

function largestThumb(node: unknown): string | undefined {
  const thumbs = deepFind(node, 'thumbnails');
  if (!Array.isArray(thumbs) || thumbs.length === 0) return undefined;
  return thumbs[thumbs.length - 1]?.url as string | undefined;
}

/**
 * The channels a collaboration's Subscribe button covers.
 *
 * YouTube's own button opens a dialog listing each channel separately, and that
 * dialog's data is attached to the button — carrying the id, name AND avatar for
 * every channel. It is a far better source than decoding the entity key, which
 * yields bare ids and no names.
 */
function channelsFromDialog(data: any): ChannelRef[] {
  const items = deepFind(data, 'listViewModel')?.listItems;
  if (!Array.isArray(items)) return [];
  const refs: ChannelRef[] = [];
  for (const item of items) {
    const view = item?.listItemViewModel ?? item;
    const id = deepFind(view, 'browseId');
    if (!isChannelId(id)) continue;
    refs.push({
      id,
      title: textOf(view.title)?.trim(),
      avatar: absoluteUrl(view.leadingAccessory?.avatarViewModel?.image?.sources?.[0]?.url),
    });
  }
  return refs;
}

/**
 * Absolute https URL.
 *
 * Avatars scraped from the DOM come back protocol-relative (`//yt3.ggpht.com/…`),
 * which resolves correctly on a page but not from the extension's own origin,
 * where it would become `chrome-extension://yt3.ggpht.com/…`. These get stored,
 * so normalise before they do.
 */
function absoluteUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

/** The channel avatar for a single-channel control, from nearby renderers. */
function avatarNear(el: Element, data: any): string | undefined {
  const own = largestThumb(data);
  if (own) return absoluteUrl(own);
  const scope = el.closest('#owner, ytd-channel-renderer, ytd-grid-channel-renderer');
  if (!scope) return undefined;
  const owner = scope.querySelector('ytd-video-owner-renderer') ?? scope;
  const fromOwner = largestThumb((owner as any).data ?? (owner as any).__data?.data);
  if (fromOwner) return absoluteUrl(fromOwner);
  // Last resort: whatever avatar is already rendered in that block.
  return absoluteUrl(scope.querySelector('img')?.getAttribute('src'));
}

/**
 * Every channel a subscribe control belongs to — more than one on a collab.
 *
 * Deliberately does NOT regex the whole data blob for `UC…`: `trackingParams`
 * is base64 and produces convincing false positives.
 */
function channelsOf(el: Element): ChannelRef[] {
  const data = (el as any).data ?? (el as any).__data?.data;
  if (!data) return [];

  // Richest source first: the collab dialog carries name and avatar per channel.
  const fromDialog = channelsFromDialog(data);
  if (fromDialog.length > 1) return fromDialog;

  const single = (id: string): ChannelRef[] => [
    {
      id,
      title: titleNear(el, data) ?? fromDialog[0]?.title,
      avatar: avatarNear(el, data) ?? fromDialog[0]?.avatar,
    },
  ];

  if (isChannelId(data.channelId)) return single(data.channelId);
  if (fromDialog.length === 1) return fromDialog;

  const fromKey = idsFromEntityKey(data.subscribedEntityKey);
  if (fromKey.length === 1) return single(fromKey[0]);
  if (fromKey.length > 1) return fromKey.map((id) => ({ id }));

  // Row renderers keep the id on the browse endpoint they navigate to.
  const browseId = deepFind(data, 'browseId');
  if (isChannelId(browseId)) return single(browseId);

  const nested = deepFind(data, 'channelId');
  return isChannelId(nested) ? single(nested) : [];
}

/**
 * The channel name for a single-channel control.
 *
 * Read from the surrounding owner/row renderer rather than the button's own
 * data: a subscribe button's `title` is as likely to be the collab dialog's
 * headline as the channel's name.
 */
function titleNear(el: Element, data: any): string | undefined {
  const scope = el.closest('#owner, ytd-channel-renderer, ytd-grid-channel-renderer');
  if (scope) {
    const owner = scope.querySelector('ytd-video-owner-renderer') ?? scope;
    const ownerData = (owner as any).data ?? (owner as any).__data?.data;
    const fromOwner = textOf(deepFind(ownerData, 'title'));
    if (fromOwner) return fromOwner.trim();
  }
  return textOf(deepFind(data, 'title'))?.trim();
}

/**
 * The `data` object each control was last stamped from.
 *
 * A stamp cannot be a one-shot: YouTube REUSES its subscribe renderers across
 * an in-page navigation, so a control skipped because it already carries a tag
 * keeps the PREVIOUS video's channel — which is how the watch page's Subscribe
 * came up already "Subscribed" until a full reload. Polymer swaps the whole
 * `data` object when it re-renders an element, so comparing that reference is
 * both the correct staleness test and a cheap one: no re-reading of hundreds of
 * search-result rows on every pass.
 */
const stampedFrom = new WeakMap<Element, unknown>();

function stampChannelIds(): void {
  if (!document.documentElement) return;
  for (const host of HOSTS) {
    for (const el of Array.from(document.querySelectorAll(host))) {
      const data = (el as any).data ?? (el as any).__data?.data;
      if ((el as HTMLElement).dataset.localtubeCid && stampedFrom.get(el) === data) continue;
      const channels = channelsOf(el);
      if (channels.length === 0) continue;
      stampedFrom.set(el, data);
      // Ids stay comma-joined for selectors and __ltDiag; the full detail —
      // name and avatar per channel — rides alongside as JSON.
      (el as HTMLElement).dataset.localtubeCid = channels.map((c) => c.id).join(',');
      (el as HTMLElement).dataset.localtubeChannels = JSON.stringify(channels);
    }
  }
}

/** Re-stamp as YouTube renders more rows (infinite scroll, hover cards). */
function watchForNewHosts(): void {
  const root = document.documentElement;
  if (!root) {
    // Nothing to observe yet; try again once the document exists.
    window.setTimeout(watchForNewHosts, 50);
    return;
  }
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    window.setTimeout(() => {
      queued = false;
      stampChannelIds();
    }, 250);
  }).observe(root, { childList: true, subtree: true });
}

function publishSoon(): void {
  let attempts = 0;
  publish();
  stampChannelIds();
  const timer = window.setInterval(() => {
    stampChannelIds();
    if (publish() || ++attempts > 25) window.clearInterval(timer);
  }, 200);
}

publishSoon();
watchForNewHosts();
window.addEventListener('yt-navigate-finish', publishSoon);
window.addEventListener('popstate', publishSoon);

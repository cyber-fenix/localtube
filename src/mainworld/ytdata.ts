// MAIN-world script. The isolated content script cannot see page JavaScript, and
// the channel id LocalTube keys everything on (`UC...`) is not reliably present
// in YouTube's DOM — modern pages link channels by @handle. It *is* present in
// `ytInitialPlayerResponse` / `ytInitialData`, so we read it here and bridge it
// to the isolated world through a <html> data attribute, the same two-world
// pattern Gmail Bulk Extractor uses for Gmail's `ik` token.

const ATTR = 'localtubeChannel'; // -> data-localtube-channel
const ACCOUNT_ATTR = 'localtubeSignedin'; // -> data-localtube-signedin
const INNERTUBE_ATTR = 'localtubeInnertube'; // -> data-localtube-innertube
const CARD_CHANNELS_ATTR = 'localtubeCardChannels'; // -> data-localtube-card-channels

/**
 * The ytcfg client the isolated world needs to call Innertube itself.
 *
 * The key and client version are the page's own, read fresh — never
 * hardcoded — so they can neither be stale nor look like a bot's. Publishing
 * them is not a leak: any script on the page can read ytcfg directly.
 */
function publishInnertube(): void {
  const root = document.documentElement;
  if (!root || root.dataset[INNERTUBE_ATTR]) return;
  const cfg = (window as any).ytcfg?.data_;
  if (!cfg?.INNERTUBE_API_KEY || !cfg?.INNERTUBE_CLIENT_VERSION) return;
  root.dataset[INNERTUBE_ATTR] = JSON.stringify({
    key: cfg.INNERTUBE_API_KEY,
    clientName: cfg.INNERTUBE_CLIENT_NAME ?? 'WEB',
    clientVersion: cfg.INNERTUBE_CLIENT_VERSION,
    hl: cfg.HL,
    gl: cfg.GL,
    visitorData: cfg.VISITOR_DATA,
  });
}

/**
 * Whether a Google account is signed in.
 *
 * `ytcfg.LOGGED_IN` is the signal: an explicit boolean, present on every page,
 * and set before YouTube has finished rendering anything. Measured signed out,
 * it reads `false`.
 *
 * Deliberately NOT `ytInitialData.responseContext.mainAppWebResponseContext
 * .loggedIn`, the obvious-looking candidate: signed out that field is ABSENT
 * rather than false, so it cannot tell "signed out" apart from "not loaded
 * yet" — and getting that backwards would hide the whole extension on a page
 * that is merely still loading.
 *
 * Cookies are deliberately not consulted. SAPISID would answer this too, and
 * reading it would be a far worse look than asking the page what it already
 * says about itself.
 */
function readSignedIn(): boolean | null {
  const cfg = (window as any).ytcfg;
  const flag = cfg?.get?.('LOGGED_IN') ?? cfg?.data_?.LOGGED_IN;
  if (typeof flag === 'boolean') return flag;

  // DOM fallback, for a page that has rendered but whose config we cannot see.
  if (document.querySelector('#avatar-btn')) return true;
  if (document.querySelector('a[href*="accounts.google.com/ServiceLogin"]')) return false;
  return null;
}

/**
 * Keep the published account state current for the life of the tab.
 *
 * Signing out happens in another tab, on a page LocalTube never sees, and this
 * tab is told nothing about it. The post-navigation poll gives up after a few
 * seconds, and hanging the re-check on DOM mutations was measured to fail: an
 * idle YouTube page produces none, so a flip went unnoticed indefinitely.
 *
 * A slow heartbeat is what actually works. It costs one property read, and
 * writes the attribute only when the answer changes.
 */
function watchAccount(): void {
  window.setInterval(publishAccount, 5000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) publishAccount();
  });
}

function publishAccount(): void {
  const root = document.documentElement;
  if (!root) return;
  const state = readSignedIn();
  const next = state === null ? undefined : state ? 'yes' : 'no';
  if (root.dataset[ACCOUNT_ATTR] === next) return;
  // Left unset while unknown, so the isolated world can tell "not yet" from
  // "signed out" and choose what to assume.
  if (state === null) delete root.dataset[ACCOUNT_ATTR];
  else root.dataset[ACCOUNT_ATTR] = state ? 'yes' : 'no';
}

interface Bridged {
  videoId?: string;
  videoTitle?: string;
  published?: string;
  thumbnail?: string;
  /** Video length in seconds, from videoDetails.lengthSeconds. */
  duration?: number;
  channelId?: string;
  channelTitle?: string;
  avatar?: string;
  /** `@handle` and subscriber text, which only YouTube's own data carries. */
  handle?: string;
  subscribers?: string;
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
  // lengthSeconds is the VIDEO's length. Deliberately preferred over the
  // <video> element's duration, which during a pre-roll is the ad's.
  const length = Number(details.lengthSeconds);
  return {
    videoId: details.videoId,
    videoTitle: details.title,
    published: microformat?.publishDate ?? undefined,
    thumbnail: biggestThumb(details.thumbnail) ?? `https://i.ytimg.com/vi/${details.videoId}/hqdefault.jpg`,
    duration: Number.isFinite(length) && length > 0 ? length : undefined,
    channelId: details.channelId,
    channelTitle: details.author,
    avatar: owner ? biggestThumb(owner.thumbnail) : undefined,
    handle: handleOf(owner),
    subscribers: textOf(owner?.subscriberCountText)?.trim(),
  };
}

/**
 * The owner's `@handle`.
 *
 * YouTube writes it as a canonical base URL ("/@MohammedHijab") on the
 * navigation endpoint. It is the one place a handle appears as data rather
 * than as a link the DOM happens to render.
 */
function handleOf(node: unknown): string | undefined {
  const base = deepFind(node, 'canonicalBaseUrl');
  if (typeof base !== 'string') return undefined;
  const handle = /^\/(@[\w.-]+)$/.exec(base)?.[1];
  return handle ?? undefined;
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
  const header = deepFind((window as any).ytInitialData, 'pageHeaderViewModel');
  return {
    channelId: meta.externalId,
    channelTitle: meta.title,
    avatar: biggestThumb(meta.avatar),
    handle: typeof meta.vanityChannelUrl === 'string'
      ? /(@[\w.-]+)$/.exec(meta.vanityChannelUrl)?.[1]
      : handleOf(header),
    subscribers: subscriberTextFrom(header),
  };
}

/**
 * "2.7M subscribers" from a channel page header.
 *
 * The header states its metadata as a row of parts — handle, subscribers,
 * videos — so the subscriber one has to be recognised by what it says rather
 * than by its position, which moves.
 */
function subscriberTextFrom(header: unknown): string | undefined {
  const rows = deepFind(header, 'metadataRows');
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    for (const part of row?.metadataParts ?? []) {
      const text = textOf(part?.text)?.trim();
      if (text && /subscriber/i.test(text)) return text;
    }
  }
  return undefined;
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

/* --------------------------------------------------------- video harvest */

/**
 * Tag every video card on a channel page with what YouTube already knows.
 *
 * The Atom feed LocalTube builds its feed from returns exactly 15 uploads and
 * carries no duration at all. A channel page has both: more videos, and a
 * duration on every one. Reading it costs nothing — the data is already in the
 * page — and it grows as the user scrolls, so a visit to a channel deepens that
 * channel's feed.
 *
 * This is the ONE place LocalTube reads YouTube's own content rather than only
 * looking for a mount point. It stays defensible because it reads structured
 * Polymer data rather than scraping rendered text, it happens only on a channel
 * page, and content/harvest.ts throws away everything for channels you do not
 * follow.
 */
interface StampedVideo {
  i: string;
  t?: string;
  /** Duration as YouTube writes it: "1:50", "1:02:28". */
  d?: string;
  /** View count text: "524K". */
  v?: string;
  /** Relative publish text: "4mo ago". */
  p?: string;
  th?: string;
}

function fromLockup(lockup: any): StampedVideo | null {
  if (lockup?.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
  const id = lockup.contentId;
  if (typeof id !== 'string' || id.length === 0) return null;

  const thumb = lockup.contentImage?.thumbnailViewModel;
  const badge = thumb?.overlays?.find((o: any) => o.thumbnailBottomOverlayViewModel)
    ?.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel;
  const rows: string[] = [];
  for (const row of lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel
    ?.metadataRows ?? [])
    for (const part of row?.metadataParts ?? [])
      if (typeof part?.text?.content === 'string') rows.push(part.text.content);

  return {
    i: id,
    t: lockup.metadata?.lockupMetadataViewModel?.title?.content,
    d: typeof badge?.text === 'string' ? badge.text : undefined,
    // "524K views" style figure first, relative date second — the order
    // YouTube writes them in, and both are recognised by shape downstream.
    v: rows[0],
    p: rows[1],
    th: absoluteUrl(thumb?.image?.sources?.[0]?.url),
  };
}

/** The older grid renderer, still used on some channel layouts. */
function fromGridVideo(data: any): StampedVideo | null {
  const id = data?.videoId;
  if (typeof id !== 'string' || id.length === 0) return null;
  return {
    i: id,
    t: textOf(data.title),
    d: textOf(data.lengthText),
    v: textOf(data.viewCountText),
    p: textOf(data.publishedTimeText),
    th: absoluteUrl(largestThumb(data.thumbnail)),
  };
}

const VIDEO_HOSTS = ['ytd-rich-item-renderer', 'ytd-grid-video-renderer', 'ytd-video-renderer'];

function stampVideos(): void {
  // Channel pages only. Everywhere else this would be reading YouTube's
  // recommendations, which is not LocalTube's business.
  if (!/^\/(@|channel\/|c\/|user\/)/.test(location.pathname)) return;

  for (const host of VIDEO_HOSTS) {
    for (const el of Array.from(document.querySelectorAll(host))) {
      const data = (el as any).data ?? (el as any).__data?.data;
      if (!data) continue;
      if ((el as HTMLElement).dataset.ltVideo && stampedVideoFrom.get(el) === data) continue;
      const video = data.content?.lockupViewModel
        ? fromLockup(data.content.lockupViewModel)
        : fromGridVideo(data);
      if (!video) continue;
      stampedVideoFrom.set(el, data);
      (el as HTMLElement).dataset.ltVideo = JSON.stringify(video);
    }
  }
}

/** Same staleness rule as the channel-id stamps: Polymer reuses elements. */
const stampedVideoFrom = new WeakMap<Element, unknown>();

/* -------------------------------------------------- card channel harvest */

/**
 * The id, avatar and @handle of every channel whose video card is on screen.
 *
 * This is how a Takeout import's channels get their pictures without a single
 * request: each card YouTube renders — home grid, search results, up-next —
 * already carries its channel's avatar in the card's data. Reading it costs
 * nothing and cannot be rate-limited, because no request ever happens.
 *
 * Unlike `stampVideos`, this runs on EVERY page type. The "not LocalTube's
 * business" rule covers YouTube's recommendations as content; here only the
 * channel identity rides across, and the isolated world (like
 * content/harvest.ts) keeps it only for channels the user already follows.
 *
 * The map accumulates new finds and republishes the attribute; the isolated
 * world drains it (reads, then deletes) and feeds storage. Entries are
 * publish-once — a drained attribute is repopulated only by channels not seen
 * since the page loaded.
 */
interface CardChannel {
  id: string;
  a?: string;
  h?: string;
}

const cardChannels = new Map<string, CardChannel>();
const cardChannelsFrom = new WeakMap<Element, unknown>();

/** The byline navigation endpoint: { browseId, canonicalBaseUrl }. In the
 *  lockup it hangs off the first metadata part's command run; in the older
 *  videoRenderer, off the byline text run's navigation endpoint. */
function bylineEndpoint(metadataViewModel: any): any {
  for (const row of metadataViewModel?.contentMetadataViewModel?.metadataRows ?? []) {
    for (const part of row?.metadataParts ?? []) {
      const endpoint =
        part?.text?.commandRuns?.[0]?.onTap?.innertubeCommand?.browseEndpoint ??
        part?.text?.runs?.[0]?.navigationEndpoint?.browseEndpoint;
      if (isChannelId(endpoint?.browseId)) return endpoint;
    }
  }
  return undefined;
}

function cardChannelOf(data: any): CardChannel | null {
  // New lockup cards (home grid, channel pages): verified live to carry the
  // avatar on the metadata's decoratedAvatarViewModel and the id plus handle
  // on the byline's browse endpoint.
  const lockup = data?.content?.lockupViewModel;
  if (lockup) {
    const vm = lockup.metadata?.lockupMetadataViewModel;
    const endpoint = bylineEndpoint(vm?.metadata);
    if (!endpoint) return null;
    const sources =
      vm?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources;
    const avatar = Array.isArray(sources) ? sources[sources.length - 1]?.url : undefined;
    return {
      id: endpoint.browseId,
      a: absoluteUrl(avatar),
      h: handleOf(endpoint),
    };
  }

  // Older videoRenderer cards (search results, watch-page up-next) keep the
  // same facts on the byline text run; the avatar is optional there.
  const vr = data?.content?.videoRenderer ?? (data?.videoId ? data : null);
  if (!vr) return null;
  const run = vr.longBylineText?.runs?.[0] ?? vr.ownerText?.runs?.[0];
  const endpoint = run?.navigationEndpoint?.browseEndpoint;
  if (!isChannelId(endpoint?.browseId)) return null;
  return {
    id: endpoint.browseId,
    a: absoluteUrl(
      largestThumb(
        vr.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail,
      ),
    ),
    h: handleOf(endpoint),
  };
}

function stampCardChannels(): void {
  const root = document.documentElement;
  if (!root) return;
  let fresh = false;
  for (const host of [...VIDEO_HOSTS, 'ytd-compact-video-renderer']) {
    for (const el of Array.from(document.querySelectorAll(host))) {
      const data = (el as any).data ?? (el as any).__data?.data;
      if (!data) continue;
      if (cardChannelsFrom.get(el) === data) continue;
      cardChannelsFrom.set(el, data);
      const channel = cardChannelOf(data);
      if (!channel || cardChannels.has(channel.id)) continue;
      cardChannels.set(channel.id, channel);
      fresh = true;
    }
  }
  if (fresh && cardChannels.size > 0)
    root.dataset[CARD_CHANNELS_ATTR] = JSON.stringify([...cardChannels.values()]);
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
      // Also re-read the account here, not only in the post-navigation poll:
      // that poll gives up after a few seconds, so signing out in another tab
      // an hour later would otherwise go unnoticed until the next navigation.
      // YouTube mutates constantly, and this is one property read.
      publishAccount();
      publishInnertube();
      stampChannelIds();
      stampVideos();
      stampCardChannels();
    }, 250);
  }).observe(root, { childList: true, subtree: true });
}

function publishSoon(): void {
  let attempts = 0;
  publish();
  publishAccount();
  publishInnertube();
  stampChannelIds();
  stampVideos();
  stampCardChannels();
  const timer = window.setInterval(() => {
    publishAccount();
    publishInnertube();
    stampChannelIds();
    stampVideos();
    stampCardChannels();
    if (publish() || ++attempts > 25) window.clearInterval(timer);
  }, 200);
}

publishSoon();
watchAccount();
watchForNewHosts();
window.addEventListener('yt-navigate-finish', publishSoon);
window.addEventListener('popstate', publishSoon);

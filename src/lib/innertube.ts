// Innertube: YouTube's own JSON endpoint, called with the page's own client
// config (key, version, locale), which the MAIN-world bridge publishes from
// ytcfg. Nothing here is hardcoded, so a client-version bump on YouTube's
// side cannot strand us.
//
// Why it exists: a channel's avatar, @handle, subscriber count and title live
// nowhere in the public surfaces (the Atom feed and oEmbed carry none of
// them — verified), and HTML channel pages were measured to trigger YouTube's
// abuse detection at any useful cadence. A browse call is a few KB of JSON
// and is the exact request YouTube's own page shell makes when you open the
// channel — the cheapest complete channel lookup there is.
//
// Privacy boundary: this is still a request to youtube.com and nothing else,
// made with credentials omitted, returning only public channel data. What
// changes versus the Atom feed is that the endpoint is undocumented — a
// stability risk we absorb with tolerant extraction — not a privacy one.

/** The page's own client configuration, bridged from ytcfg. */
interface InnertubeClient {
  key: string;
  clientName: string;
  clientVersion: string;
  hl?: string;
  gl?: string;
  visitorData?: string;
}

const ATTR = 'localtubeInnertube'; // -> data-localtube-innertube

/** Cache keyed on the attribute value: ytcfg does not change within a page. */
let cached: { raw: string; client: InnertubeClient } | null = null;

function readClient(): InnertubeClient | null {
  const raw = document.documentElement.dataset[ATTR];
  if (!raw) return null;
  if (cached?.raw === raw) return cached.client;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.key !== 'string' || typeof parsed?.clientVersion !== 'string') return null;
    cached = { raw, client: parsed };
    return cached.client;
  } catch {
    return null;
  }
}

/** No bridge, no lookup — the caller skips the whole feature quietly. */
export function innertubeAvailable(): boolean {
  return readClient() !== null;
}

/** 429 means YouTube is metering us; the caller breaks the circuit. */
export class InnertubeRateLimited extends Error {}

export interface InnertubeChannel {
  avatar?: string;
  handle?: string;
  subscribers?: string;
  title?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

function lastUrl(list: unknown): string | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const url = (list[list.length - 1] as Record<string, unknown>)?.url;
  // The microformat thumbnail carries a cache-buster ("?days_since_epoch=…");
  // the image lives at the bare path.
  return typeof url === 'string' ? url.split('?')[0] : undefined;
}

/**
 * The channel "search" tab, asked for with no query.
 *
 * A plain `{browseId}` browse returns the channel's FEATURED page — every
 * shelf it renders, measured live at 1.9 MB (MrBeast), 2.9 MB (Fireship) and
 * 7.6 MB (Veritasium). LocalTube reads four small fields out of that, all of
 * which ride on the page header and are therefore present on EVERY tab. The
 * search tab with no query carries the header and an empty body: ~80 KB on
 * all five channels measured (2026-09-11), i.e. 25-95x less for identical
 * data.
 *
 * This is the one hardcoded Innertube token in the codebase, and it is a pure
 * optimisation: `channelViaInnertube` falls back to the paramless browse when
 * a params call yields nothing, so a token YouTube retires costs a bigger
 * request, never a broken feature.
 */
const SEARCH_TAB_PARAMS = 'EgZzZWFyY2jyBgQKAloA';

/**
 * One channel's avatar, handle, subscriber count and title, via browse.
 *
 * Extraction paths verified against a live response (WEB client, 2026-09):
 *   avatar:      header.pageHeaderRenderer.content.pageHeaderViewModel.image
 *                .decoratedAvatarViewModel.avatar.avatarViewModel.image.sources
 *                (fallback: microformat.microformatDataRenderer.thumbnail)
 *   handle:      metadata.channelMetadataRenderer.vanityChannelUrl  → /@…
 *   subscribers: the page-header metadata row after the @handle row, first
 *                part — position-based because the text is localised
 *                ("abonnés" breaks an English regex)
 *   title:       metadata.channelMetadataRenderer.title
 *
 * Returns null when the channel does not resolve (deleted, malformed id).
 * Throws InnertubeRateLimited on 429 so the caller can stop the whole pass.
 */
export async function channelViaInnertube(channelId: string): Promise<InnertubeChannel | null> {
  // The light tab first; the full page only if that told us nothing.
  return (
    (await browseChannel(channelId, SEARCH_TAB_PARAMS)) ?? (await browseChannel(channelId, undefined))
  );
}

async function browseChannel(
  channelId: string,
  params: string | undefined,
): Promise<InnertubeChannel | null> {
  const client = readClient();
  if (!client) return null;

  const response = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${client.key}`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: {
        client: {
          clientName: client.clientName,
          clientVersion: client.clientVersion,
          hl: client.hl,
          gl: client.gl,
          visitorData: client.visitorData,
        },
      },
      browseId: channelId,
      ...(params ? { params } : {}),
    }),
  });
  if (response.status === 429) throw new InnertubeRateLimited();
  // 400/404 covers the deleted or malformed case; anything else odd is also
  // just "no answer", never a retry storm.
  if (!response.ok) return null;

  const json: unknown = await response.json();
  if (!isRecord(json)) return null;
  const get = (node: unknown, ...path: string[]): unknown =>
    path.reduce((n: unknown, key) => (isRecord(n) ? n[key] : undefined), node);

  const vm = get(json, 'header', 'pageHeaderRenderer', 'content', 'pageHeaderViewModel');
  const avatar =
    lastUrl(get(vm, 'image', 'decoratedAvatarViewModel', 'avatar', 'avatarViewModel', 'image', 'sources')) ??
    lastUrl(get(json, 'microformat', 'microformatDataRenderer', 'thumbnail', 'thumbnails'));

  const meta = get(json, 'metadata', 'channelMetadataRenderer');
  const vanity = isRecord(meta) ? meta.vanityChannelUrl : undefined;
  const handle =
    typeof vanity === 'string' ? /(@[\w.-]+)$/.exec(vanity)?.[1] : undefined;

  // Rows: ["@handle"], ["N subscribers", "N videos"] — the second row's first
  // part is the subscriber line, whatever language it is written in.
  const rows = get(vm, 'metadata', 'contentMetadataViewModel', 'metadataRows');
  let subscribers: string | undefined;
  if (Array.isArray(rows)) {
    const row = rows[1];
    const part = isRecord(row) && Array.isArray(row.metadataParts) ? row.metadataParts[0] : undefined;
    const text = get(part, 'text', 'content');
    if (typeof text === 'string' && text.trim()) subscribers = text.trim();
  }

  const title = isRecord(meta) && typeof meta.title === 'string' ? meta.title : undefined;

  if (!avatar && !handle && !subscribers && !title) return null;
  return { avatar, handle, subscribers, title };
}

export interface InnertubeVideo {
  /** Length in seconds. */
  duration?: number;
  /** True for a Short, false for an ordinary video. */
  isShort?: boolean;
}

/**
 * One video's length and Shorts classification, via the player endpoint.
 *
 * This is the reversal of an earlier decision, and deliberately so: durations
 * were left out because the only known source was the watch page, ~725 KB of
 * HTML per video. The player endpoint answers the same question in ~10–16 KB
 * of JSON (measured live, 2026-09-10, on Shorts and an ordinary video), which
 * makes a feed-wide pass affordable where a page-scraping one never was.
 *
 * Extraction paths verified against live responses (WEB client, logged out):
 *   duration: videoDetails.lengthSeconds — a string, hence the Number()
 *   isShort:  microformat.playerMicroformatRenderer.canonicalUrl contains
 *             "/shorts/" for a Short and "/watch?v=" for anything else
 *
 * `isShortsEligible` sits right beside it and is NOT the same question — it
 * says a video could be shown as a Short, not that it is one — so the
 * canonical URL is what decides here.
 *
 * `playabilityStatus` commonly comes back UNPLAYABLE without a poToken; that
 * only concerns streaming, and the metadata this reads arrives regardless.
 */
export async function videoViaInnertube(videoId: string): Promise<InnertubeVideo | null> {
  const client = readClient();
  if (!client) return null;

  const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${client.key}`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: {
        client: {
          clientName: client.clientName,
          clientVersion: client.clientVersion,
          hl: client.hl,
          gl: client.gl,
          visitorData: client.visitorData,
        },
      },
      videoId,
    }),
  });
  if (response.status === 429) throw new InnertubeRateLimited();
  if (!response.ok) return null;

  const json: unknown = await response.json();
  if (!isRecord(json)) return null;
  const get = (node: unknown, ...path: string[]): unknown =>
    path.reduce((n: unknown, key) => (isRecord(n) ? n[key] : undefined), node);

  const seconds = Number(get(json, 'videoDetails', 'lengthSeconds'));
  const duration = Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;

  const canonical = get(json, 'microformat', 'playerMicroformatRenderer', 'canonicalUrl');
  const isShort = typeof canonical === 'string' ? canonical.includes('/shorts/') : undefined;

  if (duration === undefined && isShort === undefined) return null;
  return { duration, isShort };
}

/** The channel's Videos tab. Same standing as SEARCH_TAB_PARAMS: a hardcoded
 *  token treated as an optimisation, with the shape check below as the
 *  fallback — a wrong tab simply yields no videos. */
const VIDEOS_TAB_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';

/** One page of a channel's uploads, as YouTube's own grid renders it. */
export interface InnertubeVideoPage {
  videos: {
    id: string;
    title?: string;
    /** Duration badge text, "6:08". */
    durationText?: string;
    /** "756K views". */
    viewsText?: string;
    /** "3 months ago". */
    ageText?: string;
    thumbnail?: string;
    isShort: boolean;
  }[];
  /** Token for the next page, absent at the end of the channel. */
  continuation?: string;
}

/**
 * One page of a channel's uploads — 30 videos, plus a token for the next.
 *
 * This is the only way past the Atom feed's 15: YouTube's own channel grid,
 * paged the way the page itself pages it. Verified live (2026-09-11): the
 * Videos tab returns 30 `lockupViewModel` items and a
 * `continuationItemRenderer` token; feeding that token back as `continuation`
 * returns the next 30 under `onResponseReceivedActions[0]
 * .appendContinuationItemsAction.continuationItems`, and so on.
 *
 * It is NOT cheap — ~1.0-1.3 MB per page measured — which is why nothing calls
 * this on a schedule. See lib/deep-history.ts.
 *
 * **`hl: 'en'` is deliberate and load-bearing.** The dates and view counts
 * here are rendered text ("3 months ago", "756K views"), and lib/parse.ts
 * reads English only. Asking in the page's own locale returns "il y a 3 mois",
 * which parses to nothing and silently drops every video — verified on a live
 * fr-FR session. Nothing here is displayed, only parsed, so the language of
 * the response is ours to choose.
 */
export async function channelVideosViaInnertube(
  channelId: string,
  continuation?: string,
): Promise<InnertubeVideoPage | null> {
  const client = readClient();
  if (!client) return null;

  const response = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${client.key}`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: {
        client: {
          clientName: client.clientName,
          clientVersion: client.clientVersion,
          hl: 'en',
          gl: client.gl,
          visitorData: client.visitorData,
        },
      },
      ...(continuation ? { continuation } : { browseId: channelId, params: VIDEOS_TAB_PARAMS }),
    }),
  });
  if (response.status === 429) throw new InnertubeRateLimited();
  if (!response.ok) return null;

  const json: unknown = await response.json();
  if (!isRecord(json)) return null;
  const get = (node: unknown, ...path: string[]): unknown =>
    path.reduce((n: unknown, key) => (isRecord(n) ? n[key] : undefined), node);

  // First page: the grid hangs off whichever tab carries content. Later pages:
  // an append action. Both are lists of the same item shape.
  let items: unknown = get(json, 'onResponseReceivedActions');
  if (Array.isArray(items))
    items = get(items[0], 'appendContinuationItemsAction', 'continuationItems');
  if (!Array.isArray(items)) {
    const tabs = get(json, 'contents', 'twoColumnBrowseResultsRenderer', 'tabs');
    const withContent = Array.isArray(tabs)
      ? tabs.find((tab) => get(tab, 'tabRenderer', 'content') !== undefined)
      : undefined;
    items = get(withContent, 'tabRenderer', 'content', 'richGridRenderer', 'contents');
  }
  if (!Array.isArray(items)) return null;

  const page: InnertubeVideoPage = { videos: [] };
  for (const item of items) {
    const token = get(item, 'continuationItemRenderer', 'continuationEndpoint', 'continuationCommand', 'token');
    if (typeof token === 'string') {
      page.continuation = token;
      continue;
    }
    const lockup = get(item, 'richItemRenderer', 'content', 'lockupViewModel');
    const id = get(lockup, 'contentId');
    if (typeof id !== 'string' || !id) continue;

    const meta = get(lockup, 'metadata', 'lockupMetadataViewModel');
    const rows: string[] = [];
    const metadataRows = get(meta, 'metadata', 'contentMetadataViewModel', 'metadataRows');
    if (Array.isArray(metadataRows))
      for (const row of metadataRows) {
        const parts = isRecord(row) ? row.metadataParts : undefined;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          const text = get(part, 'text', 'content');
          if (typeof text === 'string') rows.push(text);
        }
      }

    const thumbnailVm = get(lockup, 'contentImage', 'thumbnailViewModel');
    const overlays = get(thumbnailVm, 'overlays');
    let durationText: string | undefined;
    if (Array.isArray(overlays))
      for (const overlay of overlays) {
        const badge = get(
          overlay, 'thumbnailBottomOverlayViewModel', 'badges', '0', 'thumbnailBadgeViewModel', 'text',
        );
        if (typeof badge === 'string') {
          durationText = badge;
          break;
        }
      }

    const source = get(thumbnailVm, 'image', 'sources', '0', 'url');
    page.videos.push({
      id,
      title: typeof get(meta, 'title', 'content') === 'string' ? (get(meta, 'title', 'content') as string) : undefined,
      durationText,
      // The order YouTube writes them in: views first, age second.
      viewsText: rows[0],
      ageText: rows[1],
      thumbnail: typeof source === 'string' ? source : undefined,
      isShort: get(lockup, 'contentType') === 'LOCKUP_CONTENT_TYPE_SHORTS',
    });
  }
  return page;
}

/** One page of a YouTube playlist's contents, as YouTube's own page renders it. */
export interface InnertubePlaylistPage {
  /** The playlist's own name. Only the first page carries it. */
  title?: string;
  videos: {
    id: string;
    title?: string;
    /** Channel id from the byline's own browse endpoint, never a regex. */
    channelId?: string;
    channelTitle?: string;
    channelAvatar?: string;
    /** Duration badge text, "4:13". */
    durationText?: string;
    /** "1.7M views". */
    viewsText?: string;
    /** "1 day ago". */
    ageText?: string;
    thumbnail?: string;
    isShort: boolean;
  }[];
  /** Token for the next page, absent at the end of the playlist. */
  continuation?: string;
}

/**
 * One page of an existing YouTube playlist — 100 videos, plus a token for the
 * next page.
 *
 * `browseId` is the playlist id with a `VL` prefix, which is how YouTube's own
 * playlist page asks for it. No `params`, and no referrer trickery: the
 * competitor needs `declarativeNetRequestWithHostAccess` to spoof an embed for
 * the same data, which is a permission this extension will not ask for.
 *
 * Shapes verified live (2026-09-11, signed out, WEB client):
 *   title:   metadata.playlistMetadataRenderer.title
 *   items:   contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer
 *            .content.sectionListRenderer.contents[0].itemSectionRenderer
 *            .contents — 100 `lockupViewModel` and a trailing
 *            `continuationItemViewModel`
 *   paging:  that token fed back as `continuation` returns the next 100 under
 *            onResponseReceivedActions[0].appendContinuationItemsAction
 *            .continuationItems
 *
 * Two shape details are load-bearing and were each measured rather than
 * assumed. The continuation is a `continuationItemViewModel` — NOT the
 * `continuationItemRenderer` the channel grid uses — and on a SHORT playlist
 * it arrives as a sibling section (`sectionListRenderer.contents[1]`) instead
 * of as the item list's tail, where it is a dead trigger that returns an empty
 * response. Both positions are read, and a token that yields nothing simply
 * ends the walk.
 *
 * It is NOT cheap: ~4.7 MB for a 100-video page (measured live on "Uploads
 * from Fireship"), the same order as the channel grid per video. Nothing calls
 * this on a schedule — see lib/import-playlist.ts.
 *
 * **`hl: 'en'` is deliberate**, for the same reason as the channel grid: the
 * ages and view counts here are rendered text that lib/parse.ts reads in
 * English only. None of it is ever displayed, so the language is ours to pick.
 */
export async function playlistViaInnertube(
  playlistId: string,
  continuation?: string,
): Promise<InnertubePlaylistPage | null> {
  const client = readClient();
  if (!client) return null;

  const response = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${client.key}`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: {
        client: {
          clientName: client.clientName,
          clientVersion: client.clientVersion,
          hl: 'en',
          gl: client.gl,
          visitorData: client.visitorData,
        },
      },
      ...(continuation ? { continuation } : { browseId: `VL${playlistId}` }),
    }),
  });
  if (response.status === 429) throw new InnertubeRateLimited();
  if (!response.ok) return null;

  const json: unknown = await response.json();
  if (!isRecord(json)) return null;
  const get = (node: unknown, ...path: string[]): unknown =>
    path.reduce((n: unknown, key) => (isRecord(n) ? n[key] : undefined), node);

  // A deleted or private playlist answers 200 with an alert instead of
  // contents, so "no items" and "no such playlist" are told apart here.
  const alert = get(json, 'alerts', '0', 'alertRenderer', 'type');
  if (alert === 'ERROR') return null;

  const sections = get(
    json,
    'contents', 'twoColumnBrowseResultsRenderer', 'tabs', '0', 'tabRenderer',
    'content', 'sectionListRenderer', 'contents',
  );

  let items: unknown = get(json, 'onResponseReceivedActions', '0', 'appendContinuationItemsAction', 'continuationItems');
  const page: InnertubePlaylistPage = { videos: [] };

  if (!Array.isArray(items)) {
    items = get(sections, '0', 'itemSectionRenderer', 'contents');
    const title = get(json, 'metadata', 'playlistMetadataRenderer', 'title');
    if (typeof title === 'string' && title.trim()) page.title = title.trim();
    // The short-playlist case: the continuation sits beside the item list
    // rather than inside it.
    if (Array.isArray(sections))
      for (const section of sections.slice(1)) {
        const token = continuationToken(section);
        if (token) page.continuation = token;
      }
  }
  // A parsed response with no item list is the END of the walk, not a failure:
  // a playlist shorter than one page still hands out a continuation token, and
  // following it returns exactly this — 2 KB of responseContext and nothing
  // else (measured on a 16-video playlist, 2026-09-11). Returning an empty
  // page rather than null is what lets the caller tell "that is everything"
  // from "that request failed", and so stops a complete import reporting
  // itself as truncated.
  if (!Array.isArray(items)) return page;

  for (const item of items) {
    const token = continuationToken(item);
    if (token) {
      page.continuation = token;
      continue;
    }
    const lockup = get(item, 'lockupViewModel');
    const id = get(lockup, 'contentId');
    if (typeof id !== 'string' || !id) continue;

    const meta = get(lockup, 'metadata', 'lockupMetadataViewModel');
    const title = get(meta, 'title', 'content');

    // The byline. The channel is taken from its own browse endpoint — the one
    // place a lockup states the channel id outright — and never by fishing a
    // `UC…` out of the blob, where trackingParams yields false positives.
    let channelId: string | undefined;
    let channelTitle: string | undefined;
    let viewsText: string | undefined;
    let ageText: string | undefined;
    const rows = get(meta, 'metadata', 'contentMetadataViewModel', 'metadataRows');
    if (Array.isArray(rows))
      for (const row of rows) {
        const parts = isRecord(row) ? row.metadataParts : undefined;
        if (!Array.isArray(parts)) continue;
        const browseId = get(
          parts, '0', 'text', 'commandRuns', '0', 'onTap', 'innertubeCommand', 'browseEndpoint', 'browseId',
        );
        if (typeof browseId === 'string' && browseId.startsWith('UC')) {
          channelId = browseId;
          const name = get(parts, '0', 'text', 'content');
          if (typeof name === 'string') channelTitle = name;
          continue;
        }
        // The stats row: views first, age second, the order YouTube writes
        // them in on both the playlist page and the channel grid.
        const first = get(parts, '0', 'text', 'content');
        const second = get(parts, '1', 'text', 'content');
        if (typeof first === 'string') viewsText = first;
        if (typeof second === 'string') ageText = second;
      }

    const thumbnailVm = get(lockup, 'contentImage', 'thumbnailViewModel');
    let durationText: string | undefined;
    const overlays = get(thumbnailVm, 'overlays');
    if (Array.isArray(overlays))
      for (const overlay of overlays) {
        const badge = get(
          overlay, 'thumbnailBottomOverlayViewModel', 'badges', '0', 'thumbnailBadgeViewModel', 'text',
        );
        if (typeof badge === 'string') {
          durationText = badge;
          break;
        }
      }

    page.videos.push({
      id,
      title: typeof title === 'string' ? title : undefined,
      channelId,
      channelTitle,
      channelAvatar: lastUrl(
        get(meta, 'image', 'decoratedAvatarViewModel', 'avatar', 'avatarViewModel', 'image', 'sources'),
      ),
      durationText,
      viewsText,
      ageText,
      thumbnail: lastUrl(get(thumbnailVm, 'image', 'sources')),
      isShort: get(lockup, 'contentType') === 'LOCKUP_CONTENT_TYPE_SHORTS',
    });
  }
  return page;
}

/** The playlist page's continuation token, wherever it is hiding. */
function continuationToken(node: unknown): string | undefined {
  const get = (n: unknown, ...path: string[]): unknown =>
    path.reduce((acc: unknown, key) => (isRecord(acc) ? acc[key] : undefined), n);
  const token =
    get(node, 'continuationItemViewModel', 'continuationCommand', 'innertubeCommand', 'continuationCommand', 'token') ??
    get(node, 'continuationItemRenderer', 'continuationEndpoint', 'continuationCommand', 'token');
  return typeof token === 'string' && token ? token : undefined;
}

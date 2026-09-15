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

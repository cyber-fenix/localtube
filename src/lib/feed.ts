// Builds the subscriptions-only feed from YouTube's public per-channel Atom
// feeds: https://www.youtube.com/feeds/videos.xml?channel_id=UC...
//
// No API key, no OAuth, no scraping of YouTube's HTML. Each feed returns the 15
// most recent uploads with id, title, publish date, thumbnail, description and
// view count — everything a video card needs.
//
// Requests are sent with `credentials: 'omit'`: the feed is public, so there is
// no reason to attach the user's YouTube cookies to it.

import { getData, getFeedCache, putFeedCache, updateData } from '@/lib/store';
import type { FeedCache, Video } from '@/types';

const NS = {
  atom: 'http://www.w3.org/2005/Atom',
  yt: 'http://www.youtube.com/xml/schemas/2015',
  media: 'http://search.yahoo.com/mrss/',
};

/** How many channel feeds are in flight at once. A user with 300 Takeout
 *  subscriptions must not fire 300 parallel requests at YouTube. */
const POOL_SIZE = 6;

/** Cap on the merged list held in memory; the view paginates below this. */
export const MAX_FEED_VIDEOS = 400;

/**
 * How many videos are kept per channel.
 *
 * The Atom feed only ever returns 15, but visiting a channel page harvests
 * everything YouTube has rendered there (see content/harvest.ts), so a cache
 * entry can grow well past that. This is what stops a few big channels filling
 * chrome.storage.local, which has no unlimited quota here by design.
 */
export const CHANNEL_VIDEO_LIMIT = 120;

/**
 * Combine two lists of the same channel's videos, newest first.
 *
 * `authoritative` says whether `incoming` should win on the fields both sides
 * claim. The Atom feed is authoritative: it carries an exact publish date and a
 * real view count. A channel-page harvest is not — its date is derived from
 * text like "4mo ago" — but it is the only source of a duration, so a duration
 * is always taken from whichever side has one.
 */
export function mergeVideos(existing: Video[], incoming: Video[], authoritative: boolean): Video[] {
  const byId = new Map<string, Video>();
  for (const video of existing) byId.set(video.id, video);
  for (const video of incoming) {
    const previous = byId.get(video.id);
    if (!previous) {
      byId.set(video.id, video);
      continue;
    }
    const winner = authoritative ? { ...previous, ...video } : { ...video, ...previous };
    winner.duration = previous.duration ?? video.duration;
    byId.set(video.id, winner);
  }
  return [...byId.values()]
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, CHANNEL_VIDEO_LIMIT);
}

const feedUrl = (channelId: string): string =>
  `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;

function text(parent: Element, ns: string, name: string): string {
  return parent.getElementsByTagNameNS(ns, name)[0]?.textContent?.trim() ?? '';
}

function parseFeed(xml: string, channelId: string): Video[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('malformed feed');

  const channelTitle =
    doc.getElementsByTagNameNS(NS.atom, 'title')[0]?.textContent?.trim() ?? channelId;

  const videos: Video[] = [];
  for (const entry of Array.from(doc.getElementsByTagNameNS(NS.atom, 'entry'))) {
    const id = text(entry, NS.yt, 'videoId');
    if (!id) continue;
    const views = Number(
      entry.getElementsByTagNameNS(NS.media, 'statistics')[0]?.getAttribute('views') ?? '',
    );
    videos.push({
      id,
      title: text(entry, NS.atom, 'title'),
      channelId,
      channelTitle: text(entry, NS.atom, 'name') || channelTitle,
      published: text(entry, NS.atom, 'published'),
      thumbnail:
        entry.getElementsByTagNameNS(NS.media, 'thumbnail')[0]?.getAttribute('url') ??
        `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      views: Number.isFinite(views) ? views : undefined,
    });
  }
  return videos;
}

/**
 * A channel's display name, from the feed's own <title>.
 *
 * Used the moment someone follows a channel whose name YouTube never put on the
 * page — the second author of a collaboration, whose id is only recoverable
 * from the subscribe button's entity key. Reads the feed-level title rather
 * than a video's, so it also works for a channel with no uploads.
 */
export async function fetchChannelTitle(channelId: string): Promise<string | null> {
  try {
    const response = await fetch(feedUrl(channelId), { credentials: 'omit' });
    if (!response.ok) return null;
    const doc = new DOMParser().parseFromString(await response.text(), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) return null;
    return doc.getElementsByTagNameNS(NS.atom, 'title')[0]?.textContent?.trim() || null;
  } catch {
    return null;
  }
}

export async function fetchChannelFeed(channelId: string): Promise<Video[]> {
  const response = await fetch(feedUrl(channelId), { credentials: 'omit' });
  if (!response.ok) throw new Error(`feed ${response.status}`);
  return parseFeed(await response.text(), channelId);
}

/** Merge cached channel feeds into one reverse-chronological list. */
export function mergeCache(cache: FeedCache, channelIds: string[]): Video[] {
  const videos: Video[] = [];
  for (const id of channelIds) videos.push(...(cache[id]?.videos ?? []));
  return videos
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, MAX_FEED_VIDEOS);
}

/** Run `task` over `items` with at most `POOL_SIZE` in flight. */
export async function pool<T>(items: T[], task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(POOL_SIZE, items.length) }, async () => {
    while (cursor < items.length) await task(items[cursor++]);
  });
  await Promise.all(workers);
}

export interface FeedStatus {
  /** Channels being revalidated in this pass. */
  refreshing: number;
  done: number;
  /** Channel ids whose feed could not be fetched (deleted, renamed, offline). */
  failed: string[];
}

/**
 * Stale-while-revalidate: calls `onUpdate` immediately with whatever is cached,
 * then again as fresher channels arrive. The caller renders on every call.
 */
export async function loadFeed(
  onUpdate: (videos: Video[], status: FeedStatus) => void,
  opts: { force?: boolean } = {},
): Promise<void> {
  const data = await getData();
  const channelIds = Object.keys(data.subscriptions);
  const cache = await getFeedCache();

  const ttlMs = data.settings.feedTtlMinutes * 60_000;
  const stale = channelIds.filter(
    (id) => opts.force || !cache[id] || Date.now() - cache[id].fetchedAt > ttlMs,
  );

  const status: FeedStatus = { refreshing: stale.length, done: 0, failed: [] };
  onUpdate(mergeCache(cache, channelIds), status);

  if (stale.length === 0) return;

  // Re-render as results land, but not more than a few times a second — with
  // hundreds of channels a render per response would thrash the page.
  let lastRender = 0;
  const maybeRender = (force: boolean): void => {
    if (!force && Date.now() - lastRender < 400) return;
    lastRender = Date.now();
    onUpdate(mergeCache(cache, channelIds), { ...status, failed: [...status.failed] });
  };

  await pool(stale, async (channelId) => {
    try {
      // Merged, not replaced: everything harvested from the channel page would
      // otherwise be thrown away by the next routine refresh.
      cache[channelId] = {
        fetchedAt: Date.now(),
        videos: mergeVideos(cache[channelId]?.videos ?? [], await fetchChannelFeed(channelId), true),
      };
    } catch (error) {
      // Keep the previous videos; a transient failure should not empty the feed.
      cache[channelId] = {
        fetchedAt: Date.now(),
        videos: cache[channelId]?.videos ?? [],
        error: error instanceof Error ? error.message : 'fetch failed',
      };
      status.failed.push(channelId);
    }
    status.done++;
    maybeRender(false);
  });

  await putFeedCache(cache, channelIds);
  await backfillTitles(cache, channelIds);
  maybeRender(true);
}

/**
 * Give a channel its real name once its feed has been read.
 *
 * A channel followed through a collaboration's Subscribe button starts out
 * stored under its raw `UC…` id, because YouTube never exposes the second
 * author's name on the watch page. The feed carries it, so use it.
 */
async function backfillTitles(cache: FeedCache, channelIds: string[]): Promise<void> {
  const named = new Map<string, string>();
  for (const id of channelIds) {
    const title = cache[id]?.videos[0]?.channelTitle;
    if (title && title !== id) named.set(id, title);
  }
  if (named.size === 0) return;

  await updateData((data) => {
    for (const [id, title] of named) {
      const subscription = data.subscriptions[id];
      // Only replace a placeholder, never a name the user already sees.
      if (subscription && subscription.title === id) subscription.title = title;
    }
  });
}

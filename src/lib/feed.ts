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
import { noteNewUploads } from '@/lib/notifications';
import { t } from '@/lib/i18n';
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
 * How many videos are kept per channel, by default.
 *
 * The Atom feed only ever returns 15, but visiting a channel page harvests
 * everything YouTube has rendered there (see content/harvest.ts), and pressing
 * "Load older videos" (lib/deep-history.ts) pages back through YouTube's own
 * channel grid — so a cache entry can grow well past 15. This is what stops a
 * few big channels filling chrome.storage.local, which has no unlimited quota
 * here by design.
 *
 * ONE real ceiling: `settings.channelVideoLimit` (this constant is only its
 * default for a fresh install) caps a channel's stored videos no matter how
 * they arrived — routine refresh, a channel-page harvest, or an explicit deep
 * load. An earlier version gave a deep-loaded channel a separate, higher fixed
 * cap (600) that ignored this setting entirely, which is exactly backwards
 * from what "keep up to N videos per channel" should mean: setting it to 120
 * still let one press of "Load older videos" balloon a channel to 430.
 * Raise this setting itself if you want deep-loaded channels to hold more.
 */
export const CHANNEL_VIDEO_LIMIT = 120;

/** This channel's cap. A thin wrapper kept for call-site symmetry with the
 *  merge functions below, which all take a limit as their last argument. */
export const videoLimitFor = (baseLimit: number = CHANNEL_VIDEO_LIMIT): number => baseLimit;

/**
 * Combine two lists of the same channel's videos, newest first.
 *
 * `authoritative` says whether `incoming` should win on the fields both sides
 * claim. The Atom feed is authoritative: it carries an exact publish date and a
 * real view count. A channel-page harvest is not — its date is derived from
 * text like "4mo ago" — but it is the only source of a duration, so a duration
 * is always taken from whichever side has one. The same holds for the Shorts
 * flag, which the Atom feed never carries at all.
 */
export function mergeVideos(
  existing: Video[],
  incoming: Video[],
  authoritative: boolean,
  limit: number = CHANNEL_VIDEO_LIMIT,
): Video[] {
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
    // Same rule as duration, for the same reason: only one side ever knows,
    // and whichever side that is must survive the merge. The Atom feed never
    // classifies, so a refresh must not wipe a classification a channel page
    // or the player lookup already established.
    winner.isShort = previous.isShort ?? video.isShort;
    byId.set(video.id, winner);
  }
  return [...byId.values()]
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, limit);
}

const feedUrl = (channelId: string): string =>
  `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;

function text(parent: Element, ns: string, name: string): string {
  return parent.getElementsByTagNameNS(ns, name)[0]?.textContent?.trim() ?? '';
}

function parseFeed(xml: string, channelId: string): Video[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error(t('error_malformed_feed'));

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
  if (!response.ok) throw new Error(t('error_feed_status', String(response.status)));
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
 * The revalidation pass currently in flight, shared by concurrent callers.
 *
 * route() re-runs on every storage write in ANY tab (a progress flush from a
 * video opened in another tab, a harvest note), and every run asks for the
 * feed again. Without coalescing, each started its own full pass: the fresh
 * cache is only persisted when the WHOLE pool is done, which a big import
 * puts tens of seconds away, so every overlapping run found everything stale
 * and launched another hundred fetches — 404s logged again and again, the
 * view rebuilding itself until the neighbouring tab was closed. One pass in
 * flight per tab; concurrent callers JOIN it (below) instead of starting
 * another.
 *
 * Joining matters, not just coalescing: a caller that only painted the
 * not-yet-persisted storage cache once and never heard from the pass again
 * could stick on its initial (possibly empty) state — the pass's completion
 * paints go to the first caller, whose view may be token-dead by then, and
 * nothing re-renders. The feed then "vanishes seconds after loading" until a
 * manual refresh.
 */
let pendingPass: {
  promise: Promise<void>;
  listeners: Set<(videos: Video[], status: FeedStatus) => void>;
} | null = null;

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

  // Coalescing (see pendingPass): JOIN the pass already running — paint this
  // caller's initial cached state, then keep receiving its updates from the
  // pass's in-memory cache as results land and when it completes. The status
  // stays neutral here ("Updating" belongs to the pass's own caller), because
  // the in-flight pass decides freshness, not this caller.
  if (stale.length > 0 && !opts.force && pendingPass) {
    onUpdate(mergeCache(cache, channelIds), { refreshing: 0, done: 0, failed: [] });
    const pass = pendingPass;
    pass.listeners.add(onUpdate);
    try {
      await pass.promise;
    } finally {
      pass.listeners.delete(onUpdate);
    }
    return;
  }

  const status: FeedStatus = { refreshing: stale.length, done: 0, failed: [] };
  onUpdate(mergeCache(cache, channelIds), status);

  if (stale.length === 0) return;

  // Everyone this pass paints for: its own caller plus any loadFeed caller
  // that joined it above. A listener whose view was replaced in the meantime
  // is a no-op (its paint checks the render token), and it is dropped when
  // the pass settles either way.
  const listeners = new Set<(videos: Video[], feedStatus: FeedStatus) => void>();
  const notify = (feedStatus: FeedStatus): void => {
    const merged = mergeCache(cache, channelIds);
    onUpdate(merged, feedStatus);
    for (const listener of listeners) {
      try {
        listener(merged, feedStatus);
      } catch {
        // One listener's paint must never be able to break the pass.
      }
    }
  };

  // Re-render as results land, but not more than a few times a second — with
  // hundreds of channels a render per response would thrash the page.
  let lastRender = 0;
  const maybeRender = (force: boolean): void => {
    if (!force && Date.now() - lastRender < 400) return;
    lastRender = Date.now();
    notify({ ...status, failed: [...status.failed] });
  };

  // The pass promise is created and pendingPass is registered in the same
  // synchronous run, so no other loadFeed caller can slip in between and miss
  // it (callers only interleave at await points).
  // Uploads this pass discovers, for the bell. Collected rather than written
  // per channel: one write at the end of the pass, like every other writer
  // here.
  const discovered: Video[] = [];

  const pass = (async (): Promise<void> => {
    await pool(stale, async (channelId) => {
      try {
        const previous = cache[channelId]?.videos ?? [];
        const incoming = await fetchChannelFeed(channelId);
        // Only a channel LocalTube has already read counts as having "new"
        // videos. A channel being loaded for the first time — the whole of a
        // Takeout import — would otherwise announce its entire back catalogue.
        if (previous.length > 0) {
          const seen = new Set(previous.map((video) => video.id));
          for (const video of incoming) if (!seen.has(video.id)) discovered.push(video);
        }
        // Merged, not replaced: everything harvested from the channel page would
        // otherwise be thrown away by the next routine refresh.
        cache[channelId] = {
          ...cache[channelId],
          fetchedAt: Date.now(),
          videos: mergeVideos(
            previous,
            incoming,
            true,
            videoLimitFor(data.settings.channelVideoLimit),
          ),
          error: undefined,
        };
      } catch (error) {
        // Keep the previous videos; a transient failure should not empty the feed.
        cache[channelId] = {
          ...cache[channelId],
          fetchedAt: Date.now(),
          videos: cache[channelId]?.videos ?? [],
          error: error instanceof Error ? error.message : t('error_fetch_failed'),
        };
        status.failed.push(channelId);
      }
      status.done++;
      maybeRender(false);
    });

    await putFeedCache(cache, channelIds);
    await backfillTitles(cache, channelIds);
    await noteNewUploads(discovered);
    // Final paint AFTER the cache is persisted: joined callers re-render from
    // the same data a later route rerun would read back from storage.
    maybeRender(true);
  })();

  if (!opts.force) {
    pendingPass = { promise: pass, listeners };
    try {
      await pass;
    } finally {
      if (pendingPass?.promise === pass) pendingPass = null;
    }
  } else {
    await pass;
  }
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

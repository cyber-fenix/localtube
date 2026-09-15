// Deepen a channel's feed from its own page.
//
// The Atom feed gives 15 uploads and no durations. A channel page has already
// rendered more than that, with a duration on every card, and renders more as
// you scroll. So visiting a channel is an opportunity: take what is on screen,
// merge it into that channel's cache, and the LocalTube feed gets both older
// videos and duration badges for free.
//
// Two limits, both deliberate:
//
//  - Only channels you follow. Everything harvested for anyone else is dropped
//    on the floor. LocalTube keeps no record of channels you did not ask for,
//    and a cache quietly full of channels you merely glanced at would be a
//    different product.
//  - Capped per channel (see CHANNEL_VIDEO_LIMIT). chrome.storage.local has an
//    ordinary quota here, deliberately: asking for unlimitedStorage to hoard
//    video lists is not a trade this extension should make.

import { currentRoute } from '@/content/youtube-dom';
import { readContext } from '@/content/page-context';
import { CHANNEL_VIDEO_LIMIT, mergeVideos } from '@/lib/feed';
import { getData, getFeedCache, putFeedCache } from '@/lib/store';
import type { Video } from '@/types';

/** What the MAIN world stamps onto each card. */
interface StampedVideo {
  i: string;
  t?: string;
  d?: string;
  v?: string;
  p?: string;
  th?: string;
}

/** "1:50" / "16:40" / "1:02:28" → seconds. */
export function parseDuration(text?: string): number | undefined {
  if (!text) return undefined;
  const parts = text.trim().split(':').map((n) => Number(n));
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 ? seconds : undefined;
}

/** "524K" / "1.2M views" / "7,712 views" → a number. */
export function parseViews(text?: string): number | undefined {
  if (!text) return undefined;
  const match = /([\d.,]+)\s*([KMB])?/i.exec(text.replace(/\s/g, ''));
  if (!match) return undefined;
  const value = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return undefined;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[(match[2] ?? '').toLowerCase()] ?? 1;
  return Math.round(value * scale);
}

/**
 * "4mo ago" / "3 days ago" / "1y ago" → an ISO date.
 *
 * An approximation, and knowingly so: the channel page states ages, not dates.
 * It is resolved to an absolute timestamp here, at harvest time, so it does not
 * drift afterwards, and the Atom feed's exact date always wins where both exist
 * (see mergeVideos). Its only job is to sort a video roughly correctly among
 * others in the feed.
 */
export function parseAge(text?: string): string | undefined {
  if (!text) return undefined;
  const match = /(\d+)\s*(mo|[smhdwy])[a-z]*\s*ago/i.exec(text.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    mo: 2_592_000_000,
    y: 31_536_000_000,
  };
  const span = ms[unit];
  if (!span || !Number.isFinite(amount)) return undefined;
  return new Date(Date.now() - amount * span).toISOString();
}

function toVideo(stamped: StampedVideo, channelId: string, channelTitle: string): Video | null {
  if (!stamped.i || !stamped.t) return null;
  const published = parseAge(stamped.p);
  // Without a date a video cannot be placed in a reverse-chronological feed,
  // and guessing "now" would shove it to the top above genuinely new uploads.
  if (!published) return null;
  return {
    id: stamped.i,
    title: stamped.t,
    channelId,
    channelTitle,
    published,
    thumbnail: stamped.th || `https://i.ytimg.com/vi/${stamped.i}/hqdefault.jpg`,
    views: parseViews(stamped.v),
    duration: parseDuration(stamped.d),
  };
}

/** Read every card the MAIN world has stamped on this page. */
function stampedVideos(): StampedVideo[] {
  const out: StampedVideo[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-lt-video]'))) {
    try {
      out.push(JSON.parse(el.dataset.ltVideo ?? '') as StampedVideo);
    } catch {
      // A half-written attribute during a re-render; the next pass gets it.
    }
  }
  return out;
}

/** The channel and video count of the last write, so scrolling that reveals
 *  nothing new does not rewrite storage on every pass. */
let lastWrite = { channelId: '', count: 0 };

export async function harvestChannelVideos(): Promise<number> {
  if (currentRoute() !== 'channel') {
    lastWrite = { channelId: '', count: 0 };
    return 0;
  }

  const context = readContext();
  const channelId = context?.channelId;
  if (!channelId) return 0;

  const stamped = stampedVideos();
  if (stamped.length === 0) return 0;
  if (lastWrite.channelId === channelId && stamped.length <= lastWrite.count) return 0;

  const { subscriptions } = await getData();
  const subscription = subscriptions[channelId];
  // Not a channel you follow: nothing to deepen, and nothing worth keeping.
  if (!subscription) return 0;

  const videos = stamped
    .map((item) => toVideo(item, channelId, context.channelTitle ?? subscription.title))
    .filter((video): video is Video => video !== null);
  if (videos.length === 0) return 0;

  const cache = await getFeedCache();
  const before = cache[channelId]?.videos ?? [];
  // Not authoritative: the feed's exact dates and view counts win, and only the
  // durations and the videos the feed never carried are taken from here.
  const merged = mergeVideos(before, videos, false);
  if (merged.length === before.length && before.every((video) => video.duration)) {
    lastWrite = { channelId, count: stamped.length };
    return 0;
  }

  cache[channelId] = {
    fetchedAt: cache[channelId]?.fetchedAt ?? 0,
    videos: merged.slice(0, CHANNEL_VIDEO_LIMIT),
    error: cache[channelId]?.error,
  };
  await putFeedCache(cache, Object.keys(subscriptions));
  lastWrite = { channelId, count: stamped.length };
  return merged.length - before.length;
}


/**
 * Keep harvesting as the page grows.
 *
 * A channel page renders ~30 videos and loads more on scroll, so a single pass
 * at navigation time would only ever see the first screenful. Throttled hard:
 * this ends in a storage write, and the early-out above means most passes cost
 * one querySelectorAll and nothing else.
 */
export function watchForHarvest(): void {
  let queued = false;
  const run = (): void => {
    if (queued) return;
    queued = true;
    window.setTimeout(() => {
      queued = false;
      void harvestChannelVideos().catch(() => undefined);
    }, 1500);
  };
  window.addEventListener('scroll', run, { passive: true });
}

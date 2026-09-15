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
import { mergeVideos, videoLimitFor } from '@/lib/feed';
import { parseAge, parseDuration, parseViews } from '@/lib/parse';

export { parseAge, parseDuration, parseViews };
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
  /** 1 for a Short, 0 for an ordinary video; absent when the card did not say. */
  s?: 0 | 1;
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
    isShort: stamped.s === undefined ? undefined : stamped.s === 1,
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

  // Which tab a card came from is itself a classification, and a free one.
  // Kept separately from `videos` because a Shorts card carries no publish
  // date, so it cannot become a feed entry on its own — but the same Short
  // has almost certainly already arrived through the Atom feed, where nothing
  // distinguishes it from an upload, and this is what tells them apart.
  const marks = new Map<string, boolean>();
  for (const item of stamped)
    if (item.i && item.s !== undefined) marks.set(item.i, item.s === 1);

  if (videos.length === 0 && marks.size === 0) return 0;

  const cache = await getFeedCache();
  const before = cache[channelId]?.videos ?? [];
  // Not authoritative: the feed's exact dates and view counts win, and only the
  // durations and the videos the feed never carried are taken from here.
  const merged = mergeVideos(before, videos, false, videoLimitFor(cache[channelId]));

  let marked = 0;
  for (const video of merged) {
    const isShort = marks.get(video.id);
    if (isShort !== undefined && video.isShort !== isShort) {
      video.isShort = isShort;
      marked++;
    }
  }

  if (
    marked === 0 &&
    merged.length === before.length &&
    before.every((video) => video.duration || video.isShort)
  ) {
    lastWrite = { channelId, count: stamped.length };
    return 0;
  }

  cache[channelId] = {
    ...cache[channelId],
    fetchedAt: cache[channelId]?.fetchedAt ?? 0,
    videos: merged,
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

// Fill in what the Atom feed cannot say: how long a video is, and whether it
// is a Short.
//
// The feed carries neither. It does not even separate the two — a channel's
// Shorts arrive in the same 15 entries as its uploads, with the same shape
// (verified live: two Shorts among the 15 entries of a channel feed) — which
// is why a feed built from it mixed them together and no card could show a
// length.
//
// Channel pages answer both for free where the user happens to visit one (see
// content/harvest.ts: the Videos tab is all long-form, the Shorts tab is all
// Shorts). This is the fallback for everything else: one Innertube player
// call per video, ~10-16 KB of JSON, which is what makes a feed-wide pass
// affordable at all — see lib/innertube.ts for the size comparison that
// reversed the original "no durations" decision.

import { InnertubeRateLimited, innertubeAvailable, videoViaInnertube } from '@/lib/innertube';
import { putFeedCache } from '@/lib/store';
import type { FeedCache, Video } from '@/types';

/**
 * How many videos one pass will ask about.
 *
 * A pass runs when the feed is opened, and the feed is sorted newest first, so
 * this covers what the user is actually looking at and lets the rest arrive
 * over later visits. At ~13 KB an answer this is a few hundred KB of traffic
 * for a screenful of badges — the whole point of using the player endpoint
 * rather than watch pages, which would have been ~45 MB for the same 60.
 */
const BATCH = 60;

/** Two at a time with a pause between, the cadence lib/subscriptions.ts
 *  settled on after the avatar backfill was rate-limited at pool speed. */
const WORKERS = 2;

/** Once YouTube answers 429, stop asking for a while. A missing badge is a
 *  non-event; feeding a rate limiter is not. */
const BACKOFF_MS = 15 * 60_000;
let backoffUntil = 0;

/** Asked about this session, so a video the endpoint has no answer for is not
 *  re-asked on every feed visit. */
const attempted = new Set<string>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A video still missing something this pass could supply. A known Short needs
 *  no duration: YouTube shows no length on a Short either. */
function needsDetails(video: Video): boolean {
  if (video.isShort === undefined) return true;
  return video.isShort === false && video.duration === undefined;
}

/**
 * Ask about the newest unclassified videos and write the answers to the cache.
 *
 * Returns how many videos gained something. `onProgress` is called as answers
 * land so an open feed can repaint; the storage write happens ONCE at the end
 * of the pass, never per answer — see CLAUDE.md on why a write per result is
 * what makes the feed rebuild itself under the user's cursor.
 */
export async function backfillVideoDetails(
  cache: FeedCache,
  channelIds: string[],
  onProgress?: () => void,
): Promise<number> {
  if (!innertubeAvailable() || Date.now() < backoffUntil) return 0;

  // Newest first, so the pass spends its budget on what is on screen.
  const pending: { channelId: string; video: Video }[] = [];
  for (const channelId of channelIds)
    for (const video of cache[channelId]?.videos ?? [])
      if (needsDetails(video) && !attempted.has(video.id)) pending.push({ channelId, video });
  if (pending.length === 0) return 0;
  pending.sort((a, b) => Date.parse(b.video.published) - Date.parse(a.video.published));
  const batch = pending.slice(0, BATCH);

  let found = 0;
  const touched = new Set<string>();
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < batch.length && Date.now() >= backoffUntil) {
      const { channelId, video } = batch[cursor++];
      attempted.add(video.id);
      const details = await videoViaInnertube(video.id);
      if (details) {
        // Mutating the cached object in place: `cache` is the same object the
        // caller merges its view from, so an open feed can repaint from it
        // without waiting for the storage round-trip.
        if (details.duration !== undefined && video.duration === undefined)
          video.duration = details.duration;
        if (details.isShort !== undefined && video.isShort === undefined)
          video.isShort = details.isShort;
        touched.add(channelId);
        found++;
        onProgress?.();
      }
      if (cursor < batch.length) await sleep(200 + Math.random() * 300);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(WORKERS, batch.length) }, worker));
  } catch (error) {
    if (!(error instanceof InnertubeRateLimited)) throw error;
    backoffUntil = Date.now() + BACKOFF_MS;
    console.warn('[LocalTube] video details paused — Innertube rate-limited');
  }

  if (touched.size === 0) return 0;
  const patch: FeedCache = {};
  for (const channelId of touched) if (cache[channelId]) patch[channelId] = cache[channelId];
  await putFeedCache(patch, channelIds);
  return found;
}

// Where you stopped watching, so the next visit picks the video back up.
//
// Two things this is deliberately NOT:
//
//  - It is not the history list. Resume has to work for a video watched while
//    history was paused, and a history entry falling off the end of the list
//    must not take your position with it. Hence its own map, keyed by video id.
//  - It is not a play log. One position per video, overwritten, so re-watching
//    something does not grow the store.

import { PROGRESS_LIMIT, getData, getSettings, updateData } from '@/lib/store';
import type { ProgressEntry } from '@/types';

/** Below this many seconds there is nothing worth resuming — you had barely
 *  started, and being dropped 8 seconds in is more jarring than helpful. */
export const MIN_RESUME_SECONDS = 15;

/** At or past this fraction the video counts as finished: we stop offering to
 *  resume (nobody wants to land in the outro) and the card shows a full bar. */
export const DONE_FRACTION = 0.95;

export async function resumeEnabled(): Promise<boolean> {
  return (await getSettings()).resumePlayback;
}

export async function listProgress(): Promise<Record<string, ProgressEntry>> {
  return (await getData()).progress;
}

export async function getProgress(videoId: string): Promise<ProgressEntry | undefined> {
  return (await getData()).progress[videoId];
}

/** How far through the video this position is, 0..1. */
export function watchedFraction(entry: ProgressEntry | undefined): number {
  if (!entry || !(entry.duration > 0)) return 0;
  return Math.min(1, Math.max(0, entry.seconds / entry.duration));
}

/** The second to seek to, or null when this position is not worth resuming.
 *  Pure, so the content script can decide without a second storage read. */
export function resumeAt(entry: ProgressEntry | undefined): number | null {
  if (!entry || !(entry.duration > 0)) return null;
  if (entry.seconds < MIN_RESUME_SECONDS) return null;
  if (entry.seconds >= entry.duration * DONE_FRACTION) return null;
  return entry.seconds;
}

/**
 * Record a position.
 *
 * A no-op while resume is switched off — checked here rather than at the call
 * site, so nothing can record by forgetting to ask, the same rule `recordWatch`
 * follows.
 *
 * A live stream reports a duration of 0 or Infinity and has no meaningful
 * position, so it is ignored rather than stored as a nonsense fraction.
 */
export async function saveProgress(
  videoId: string,
  seconds: number,
  duration: number,
): Promise<boolean> {
  if (!videoId) return false;
  if (!Number.isFinite(seconds) || !Number.isFinite(duration)) return false;
  if (duration <= 0 || seconds < 1) return false;

  return updateData((data) => {
    if (!data.settings.resumePlayback) return false;
    data.progress[videoId] = {
      seconds: Math.min(seconds, duration),
      duration,
      updatedAt: Date.now(),
    };
    prune(data.progress);
    return true;
  });
}

export async function clearProgress(videoId: string): Promise<void> {
  await updateData((data) => {
    delete data.progress[videoId];
  });
}

/** Drop the least recently updated positions once the map is over its cap. */
export function prune(progress: Record<string, ProgressEntry>): void {
  const ids = Object.keys(progress);
  if (ids.length <= PROGRESS_LIMIT) return;
  ids
    .sort((a, b) => progress[a].updatedAt - progress[b].updatedAt)
    .slice(0, ids.length - PROGRESS_LIMIT)
    .forEach((id) => delete progress[id]);
}

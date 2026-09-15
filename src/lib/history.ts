// Watch history. Local, capped, and off with one switch.
//
// History is the one LocalTube list that fills itself, which is why it is the
// one that needs a stop button and a size limit. It lives inside LocalTubeData
// rather than beside the feed cache — a backup that dropped your history would
// not be a backup of your account.

import { HISTORY_LIMIT, getData, getSettings, setSettings, updateData } from '@/lib/store';
import type { HistoryEntry, Video } from '@/types';

/** Newest first. */
export async function listHistory(): Promise<HistoryEntry[]> {
  return (await getData()).history;
}

export async function historyEnabled(): Promise<boolean> {
  return (await getSettings()).recordHistory;
}

export async function setHistoryEnabled(on: boolean): Promise<void> {
  await setSettings({ recordHistory: on });
}

/**
 * Record a watch. Re-watching moves the video to the top and updates its time
 * rather than adding a second row — the list is "what you have watched", not a
 * play log.
 *
 * A no-op while recording is paused, checked here rather than at every call
 * site so nothing can record by forgetting to ask.
 */
export async function recordWatch(video: Video): Promise<boolean> {
  return updateData((data) => {
    if (!data.settings.recordHistory) return false;
    const existing = data.history.find((entry) => entry.id === video.id);
    const merged: HistoryEntry = {
      // Keep whatever details we already had: the watch page knows the title
      // and channel, but not the publish date the feed carries.
      ...(existing ?? {}),
      ...video,
      published: video.published || existing?.published || '',
      watchedAt: Date.now(),
    };
    data.history = [merged, ...data.history.filter((entry) => entry.id !== video.id)].slice(
      0,
      HISTORY_LIMIT,
    );
    return true;
  });
}

export async function removeFromHistory(videoId: string): Promise<void> {
  await updateData((data) => {
    data.history = data.history.filter((entry) => entry.id !== videoId);
  });
}

export async function clearHistory(): Promise<void> {
  await updateData((data) => {
    data.history = [];
  });
}

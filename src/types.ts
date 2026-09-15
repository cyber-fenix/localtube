/** A video, as it appears in the feed or saved inside a playlist. */
export interface Video {
  /** YouTube video id (the `v=` parameter). */
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  /** ISO 8601 publish date from the channel feed. */
  published: string;
  thumbnail: string;
  views?: number;
  /**
   * Length in seconds. Known only for videos LocalTube has seen on a watch
   * page — the channel feed carries no duration at all — so a card shows a
   * badge for something you have watched and nothing for anything else.
   */
  duration?: number;
  /** Epoch ms, set when the video is saved to a playlist. */
  addedAt?: number;
}

/** A locally followed channel. Never leaves the browser. */
export interface Subscription {
  /** Channel id, always `UC...`. The one stable identifier YouTube exposes. */
  id: string;
  title: string;
  avatar?: string;
  addedAt: number;
  /** `@handle`, as YouTube writes it. Captured when we see the channel on a
   *  watch or channel page; the feed does not carry it. */
  handle?: string;
  /** Subscriber count as YouTube phrases it ("2.7M subscribers"), kept as its
   *  text because that is what YouTube displays and what it gives us. */
  subscribers?: string;
  /** When handle/subscribers were last refreshed, so a stale figure can be
   *  told from one that was never known. */
  detailsAt?: number;
}

/** Playlists LocalTube creates itself; they cannot be renamed or deleted. */
export type SystemPlaylist = 'watch-later' | 'liked' | 'disliked';

export interface Playlist {
  id: string;
  name: string;
  system?: SystemPlaylist;
  videos: Video[];
  createdAt: number;
}

/** A watched video, newest first. Local only — never sent anywhere. */
export interface HistoryEntry extends Video {
  /** Epoch ms of the most recent watch. */
  watchedAt: number;
}

/**
 * Where you stopped watching a video.
 *
 * Kept as its own map rather than on the history entry: resume has to work for
 * a video you watched with history paused, and a history entry that falls off
 * the end of the list should not silently forget your position.
 */
export interface ProgressEntry {
  /** Seconds into the video. */
  seconds: number;
  /** The video's full length, so a saved position can be read as a fraction. */
  duration: number;
  /** Epoch ms of the last update; also what gets pruned first. */
  updatedAt: number;
}

export interface Settings {
  /** How long a channel's cached feed stays fresh before revalidating. */
  feedTtlMinutes: number;
  /** Replace YouTube's home grid with the LocalTube feed. */
  replaceHome: boolean;
  /** Hide YouTube's own signed-out controls and wear its styling instead. */
  nativeSkin: boolean;
  /** Record watched videos in the local History list. */
  recordHistory: boolean;
  /** Remember where you stopped and pick the video back up there. */
  resumePlayback: boolean;
}

/** Everything a backup contains. Bump `version` only with a migration. */
export interface LocalTubeData {
  version: number;
  subscriptions: Record<string, Subscription>;
  playlists: Record<string, Playlist>;
  /** Watch history, newest first, capped at HISTORY_LIMIT. */
  history: HistoryEntry[];
  /** Where you stopped, by video id. Capped at PROGRESS_LIMIT. */
  progress: Record<string, ProgressEntry>;
  settings: Settings;
}

/** Per-channel feed cache. Deliberately outside LocalTubeData — derived data,
 *  never backed up, safe to drop at any time. */
export interface FeedCacheEntry {
  fetchedAt: number;
  videos: Video[];
  /** Set when the last fetch failed (deleted channel, network error). */
  error?: string;
}

export type FeedCache = Record<string, FeedCacheEntry>;

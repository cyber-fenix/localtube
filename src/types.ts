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

export interface Settings {
  /** How long a channel's cached feed stays fresh before revalidating. */
  feedTtlMinutes: number;
  /** Replace YouTube's home grid with the LocalTube feed. */
  replaceHome: boolean;
  /** Hide YouTube's own signed-out controls and wear its styling instead. */
  nativeSkin: boolean;
  /** Record watched videos in the local History list. */
  recordHistory: boolean;
}

/** Everything a backup contains. Bump `version` only with a migration. */
export interface LocalTubeData {
  version: number;
  subscriptions: Record<string, Subscription>;
  playlists: Record<string, Playlist>;
  /** Watch history, newest first, capped at HISTORY_LIMIT. */
  history: HistoryEntry[];
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

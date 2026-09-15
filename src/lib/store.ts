// The single chrome.storage.local layer. No other module touches
// chrome.storage directly — that keeps the schema, the defaults, and the
// backup surface in one place.
//
// chrome.storage.sync is unusable here: its 100 KB quota cannot hold a few
// hundred subscriptions plus playlists. That limitation is exactly why
// LocalTube ships an explicit backup/restore instead.

import type { FeedCache, LocalTubeData, Playlist, Settings, SystemPlaylist } from '@/types';

export const SCHEMA_VERSION = 1;

/**
 * Thrown when the extension has been reloaded, updated or disabled while this
 * content script is still running in an already-open tab.
 *
 * The orphaned script keeps executing but its `chrome.*` APIs are dead, so
 * every storage call throws "Extension context invalidated." The content script
 * catches this and tears itself down instead of logging it on every tick.
 */
export class ContextInvalidated extends Error {
  constructor() {
    super('Extension context invalidated');
    this.name = 'ContextInvalidated';
  }
}

/** False once the extension has been reloaded out from under this page. */
export function contextAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

/** Run a chrome.storage call, converting a dead context into a typed error. */
async function storage<T>(run: () => Promise<T>): Promise<T> {
  if (!contextAlive()) throw new ContextInvalidated();
  try {
    return await run();
  } catch (error) {
    if (!contextAlive() || /context invalidated/i.test(String(error))) throw new ContextInvalidated();
    throw error;
  }
}

const DATA_KEY = 'localtube_data_v1';
const CACHE_KEY = 'localtube_feed_cache';

export const DEFAULT_SETTINGS: Settings = {
  feedTtlMinutes: 20,
  replaceHome: true,
  nativeSkin: true,
};

/** Fixed playlists, created on first read so the rest of the code can assume
 *  they exist. Their ids are stable so backups restore onto them cleanly. */
const SYSTEM_PLAYLISTS: Record<SystemPlaylist, { id: string; name: string }> = {
  'watch-later': { id: 'system-watch-later', name: 'Watch Later' },
  liked: { id: 'system-liked', name: 'Liked' },
  disliked: { id: 'system-disliked', name: 'Disliked' },
};

/** Display order for the fixed playlists. */
export const SYSTEM_ORDER: SystemPlaylist[] = ['watch-later', 'liked', 'disliked'];

function emptyData(): LocalTubeData {
  return {
    version: SCHEMA_VERSION,
    subscriptions: {},
    playlists: {},
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** Add any missing system playlist. Returns true if something was added. */
function ensureSystemPlaylists(data: LocalTubeData): boolean {
  let changed = false;
  for (const [system, { id, name }] of Object.entries(SYSTEM_PLAYLISTS) as [
    SystemPlaylist,
    { id: string; name: string },
  ][]) {
    const existing = Object.values(data.playlists).find((p) => p.system === system);
    if (existing) continue;
    data.playlists[id] = { id, name, system, videos: [], createdAt: Date.now() };
    changed = true;
  }
  return changed;
}

/** Read the whole store, merged over defaults, with system playlists present. */
export async function getData(): Promise<LocalTubeData> {
  const got = await storage(() => chrome.storage.local.get(DATA_KEY));
  const saved = got[DATA_KEY] as Partial<LocalTubeData> | undefined;
  const data: LocalTubeData = {
    ...emptyData(),
    ...saved,
    settings: { ...DEFAULT_SETTINGS, ...(saved?.settings ?? {}) },
  };
  if (ensureSystemPlaylists(data)) await storage(() => chrome.storage.local.set({ [DATA_KEY]: data }));
  return data;
}

/** Overwrite the whole store. Used by restore; prefer `updateData` elsewhere. */
export async function setData(data: LocalTubeData): Promise<void> {
  await storage(() => chrome.storage.local.set({ [DATA_KEY]: { ...data, version: SCHEMA_VERSION } }));
}

/**
 * Read-modify-write under a promise chain, so two rapid clicks (subscribe +
 * save-to-playlist) cannot read the same snapshot and clobber each other.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

export function updateData<T>(mutate: (data: LocalTubeData) => T | Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const data = await getData();
    const result = await mutate(data);
    await setData(data);
    return result;
  };
  const next = writeQueue.then(run, run);
  writeQueue = next.catch(() => undefined);
  return next;
}

export async function getSettings(): Promise<Settings> {
  return (await getData()).settings;
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  return updateData((data) => {
    data.settings = { ...data.settings, ...patch };
    return data.settings;
  });
}

export function systemPlaylist(data: LocalTubeData, system: SystemPlaylist): Playlist {
  const found = Object.values(data.playlists).find((p) => p.system === system);
  // getData() guarantees these exist; the throw is a loud failure rather than a
  // silent undefined if that ever stops being true.
  if (!found) throw new Error(`missing system playlist: ${system}`);
  return found;
}

/* ---------------------------------------------------------------- feed cache */

export async function getFeedCache(): Promise<FeedCache> {
  const got = await storage(() => chrome.storage.local.get(CACHE_KEY));
  return (got[CACHE_KEY] ?? {}) as FeedCache;
}

/** Merge entries into the cache and drop entries for channels no longer
 *  subscribed, so the cache cannot grow without bound. */
export async function putFeedCache(patch: FeedCache, keepChannelIds: string[]): Promise<void> {
  const merged = { ...(await getFeedCache()), ...patch };
  const keep = new Set(keepChannelIds);
  for (const id of Object.keys(merged)) if (!keep.has(id)) delete merged[id];
  await storage(() => chrome.storage.local.set({ [CACHE_KEY]: merged }));
}

export async function clearFeedCache(): Promise<void> {
  await storage(() => chrome.storage.local.remove(CACHE_KEY));
}

/* --------------------------------------------------------------- change feed */

/** Notify when the store changes — lets an open YouTube tab react to an edit
 *  made in the popup without a reload. */
export function onDataChanged(cb: (data: LocalTubeData) => void): void {
  if (!contextAlive()) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[DATA_KEY]) return;
    const next = changes[DATA_KEY].newValue as LocalTubeData | undefined;
    if (next) cb(next);
  });
}

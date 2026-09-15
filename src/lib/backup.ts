// Backup and restore: the only way LocalTube data moves between browsers, since
// chrome.storage.sync's 100 KB quota cannot hold a real subscription list.
//
// The feed cache is deliberately excluded — it is derived data that rebuilds
// itself, and including it would bloat every backup file.

import { SCHEMA_VERSION, getData, setData } from '@/lib/store';
import type { LocalTubeData, Playlist, Video } from '@/types';

export type ImportMode = 'merge' | 'replace';

export interface ImportSummary {
  subscriptions: number;
  playlists: number;
  videos: number;
}

export function backupFilename(): string {
  return `localtube-backup-${new Date().toISOString().slice(0, 10)}.json`;
}

export async function exportBackup(): Promise<string> {
  return JSON.stringify(await getData(), null, 2);
}

function parse(json: string): LocalTubeData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const data = parsed as Partial<LocalTubeData>;
  if (typeof data?.version !== 'number' || !data.subscriptions || !data.playlists) {
    throw new Error('That does not look like a LocalTube backup.');
  }
  // Refuse a file from a newer version outright rather than applying half of it
  // and silently dropping fields this build does not understand.
  if (data.version > SCHEMA_VERSION) {
    throw new Error(
      `This backup was made by a newer version of LocalTube (format ${data.version}). Update the extension first.`,
    );
  }
  return data as LocalTubeData;
}

function mergeVideos(into: Video[], from: Video[]): number {
  const seen = new Set(into.map((v) => v.id));
  let added = 0;
  for (const video of from) {
    if (seen.has(video.id)) continue;
    seen.add(video.id);
    into.push(video);
    added++;
  }
  into.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
  return added;
}

/** Match an incoming playlist to an existing one: system playlists by their
 *  tag, user playlists by id and then by name. */
function findTarget(current: LocalTubeData, incoming: Playlist): Playlist | undefined {
  if (incoming.system)
    return Object.values(current.playlists).find((p) => p.system === incoming.system);
  return (
    current.playlists[incoming.id] ??
    Object.values(current.playlists).find((p) => !p.system && p.name === incoming.name)
  );
}

export async function importBackup(json: string, mode: ImportMode): Promise<ImportSummary> {
  const incoming = parse(json);

  if (mode === 'replace') {
    await setData({ ...incoming, version: SCHEMA_VERSION });
    return {
      subscriptions: Object.keys(incoming.subscriptions).length,
      playlists: Object.keys(incoming.playlists).length,
      videos: Object.values(incoming.playlists).reduce((n, p) => n + p.videos.length, 0),
    };
  }

  const current = await getData();
  const summary: ImportSummary = { subscriptions: 0, playlists: 0, videos: 0 };

  for (const [id, subscription] of Object.entries(incoming.subscriptions)) {
    if (current.subscriptions[id]) continue;
    current.subscriptions[id] = subscription;
    summary.subscriptions++;
  }

  for (const playlist of Object.values(incoming.playlists)) {
    const target = findTarget(current, playlist);
    if (target) {
      summary.videos += mergeVideos(target.videos, playlist.videos);
    } else {
      current.playlists[playlist.id] = playlist;
      summary.playlists++;
      summary.videos += playlist.videos.length;
    }
  }

  await setData(current);
  return summary;
}

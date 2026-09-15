// Backup and restore: the only way LocalTube data moves between browsers, since
// chrome.storage.sync's 100 KB quota cannot hold a real subscription list.
//
// The feed cache is deliberately excluded — it is derived data that rebuilds
// itself, and including it would bloat every backup file.

import { HISTORY_LIMIT, SCHEMA_VERSION, getData, setData } from '@/lib/store';
import { prune as pruneProgress } from '@/lib/progress';
import { t } from '@/lib/i18n';
import type { HistoryEntry, LocalTubeData, Playlist, ProgressEntry, Video } from '@/types';

export type ImportMode = 'merge' | 'replace';

export interface ImportSummary {
  subscriptions: number;
  playlists: number;
  videos: number;
  history: number;
  progress: number;
}

/** What a backup file holds: the store, plus provenance that is informational
 *  only — never written back, so it cannot pollute the schema. */
interface BackupFile extends LocalTubeData {
  exportedAt?: string;
  app?: string;
}

/** The extension's own version, when we are somewhere that can ask for it. */
function appVersion(): string | undefined {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return undefined;
  }
}

export function backupFilename(): string {
  return `localtube-backup-${new Date().toISOString().slice(0, 10)}.json`;
}

export async function exportBackup(): Promise<string> {
  const file: BackupFile = {
    ...(await getData()),
    exportedAt: new Date().toISOString(),
    app: `LocalTube ${appVersion() ?? ''}`.trim(),
  };
  return JSON.stringify(file, null, 2);
}

function parse(json: string): LocalTubeData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(t('error_invalid_json'));
  }
  const data = parsed as Partial<LocalTubeData>;
  if (typeof data?.version !== 'number' || !data.subscriptions || !data.playlists) {
    throw new Error(t('error_not_a_backup'));
  }
  // Refuse a file from a newer version outright rather than applying half of it
  // and silently dropping fields this build does not understand.
  if (data.version > SCHEMA_VERSION) {
    throw new Error(t('error_backup_too_new', String(data.version)));
  }
  // Rebuild from known keys only. A file carries `exportedAt` and `app` for
  // humans, and a future build may add more; none of it belongs in the store.
  const file = data as BackupFile;
  return {
    version: file.version,
    subscriptions: file.subscriptions ?? {},
    playlists: file.playlists ?? {},
    history: file.history ?? [],
    progress: file.progress ?? {},
    settings: file.settings,
  } as LocalTubeData;
}

/** Newest watch wins, newest first, re-capped. */
function mergeHistory(into: HistoryEntry[], from: HistoryEntry[]): number {
  const byId = new Map(into.map((entry) => [entry.id, entry]));
  let added = 0;
  for (const entry of from) {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
      added++;
    } else if ((entry.watchedAt ?? 0) > (existing.watchedAt ?? 0)) {
      byId.set(entry.id, { ...existing, ...entry });
    }
  }
  into.splice(
    0,
    into.length,
    ...[...byId.values()].sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0)).slice(0, HISTORY_LIMIT),
  );
  return added;
}

/** The more recently updated position wins — it is the one you actually left. */
function mergeProgress(
  into: Record<string, ProgressEntry>,
  from: Record<string, ProgressEntry>,
): number {
  let added = 0;
  for (const [id, entry] of Object.entries(from)) {
    const existing = into[id];
    if (!existing) added++;
    else if (existing.updatedAt >= entry.updatedAt) continue;
    into[id] = entry;
  }
  pruneProgress(into);
  return added;
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
      history: incoming.history.length,
      progress: Object.keys(incoming.progress).length,
    };
  }

  const current = await getData();
  const summary: ImportSummary = {
    subscriptions: 0,
    playlists: 0,
    videos: 0,
    history: 0,
    progress: 0,
  };

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

  // History and progress were silently dropped by every merge before this:
  // the loops above cover subscriptions and playlists only, so importing a
  // backup from another browser brought none of what you had watched.
  summary.history = mergeHistory(current.history, incoming.history);
  summary.progress = mergeProgress(current.progress, incoming.progress);

  // Settings are deliberately NOT merged. They describe this browser — whether
  // the home grid is replaced here, how this machine skins YouTube — and a
  // merge that quietly reconfigured the browser you imported INTO would be a
  // surprise. Replace still takes them, because Replace means "make this
  // browser the other one".

  await setData(current);
  return summary;
}

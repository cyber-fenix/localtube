// Local playlists. "Watch Later" and "Liked" are ordinary playlists carrying a
// `system` tag, which is the only thing that stops them being renamed or
// deleted — everything else treats all playlists identically.

import { SYSTEM_ORDER, getData, systemPlaylist, updateData } from '@/lib/store';
import type { Playlist, SystemPlaylist, Video } from '@/types';

export async function listPlaylists(): Promise<Playlist[]> {
  const { playlists } = await getData();
  // System playlists first, then user playlists newest-first.
  return Object.values(playlists).sort((a, b) => {
    if (!!a.system !== !!b.system) return a.system ? -1 : 1;
    if (a.system && b.system) return SYSTEM_ORDER.indexOf(a.system) - SYSTEM_ORDER.indexOf(b.system);
    return b.createdAt - a.createdAt;
  });
}

export async function getPlaylist(id: string): Promise<Playlist | undefined> {
  return (await getData()).playlists[id];
}

export async function createPlaylist(name: string): Promise<Playlist> {
  return updateData((data) => {
    const id = `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const playlist: Playlist = { id, name: name.trim() || 'Untitled', videos: [], createdAt: Date.now() };
    data.playlists[id] = playlist;
    return playlist;
  });
}

export async function renamePlaylist(id: string, name: string): Promise<void> {
  await updateData((data) => {
    const playlist = data.playlists[id];
    if (!playlist || playlist.system) return;
    playlist.name = name.trim() || playlist.name;
  });
}

export async function deletePlaylist(id: string): Promise<void> {
  await updateData((data) => {
    if (data.playlists[id]?.system) return;
    delete data.playlists[id];
  });
}

/** Add to a playlist, newest first. Adding a video already present is a no-op
 *  rather than a duplicate. */
export async function addToPlaylist(playlistId: string, video: Video): Promise<boolean> {
  return updateData((data) => {
    const playlist = data.playlists[playlistId];
    if (!playlist || playlist.videos.some((v) => v.id === video.id)) return false;
    playlist.videos.unshift({ ...video, addedAt: Date.now() });
    return true;
  });
}

export async function removeFromPlaylist(playlistId: string, videoId: string): Promise<void> {
  await updateData((data) => {
    const playlist = data.playlists[playlistId];
    if (!playlist) return;
    playlist.videos = playlist.videos.filter((v) => v.id !== videoId);
  });
}

export async function playlistsContaining(videoId: string): Promise<Set<string>> {
  const { playlists } = await getData();
  const ids = new Set<string>();
  for (const playlist of Object.values(playlists)) {
    if (playlist.videos.some((v) => v.id === videoId)) ids.add(playlist.id);
  }
  return ids;
}

/* ------------------------------------------------------- system playlists */

export async function systemPlaylistId(system: SystemPlaylist): Promise<string> {
  return systemPlaylist(await getData(), system).id;
}

export async function isLiked(videoId: string): Promise<boolean> {
  const data = await getData();
  return systemPlaylist(data, 'liked').videos.some((v) => v.id === videoId);
}

export async function isDisliked(videoId: string): Promise<boolean> {
  const data = await getData();
  return systemPlaylist(data, 'disliked').videos.some((v) => v.id === videoId);
}

/**
 * Toggle one of the two opinion lists, clearing the other — liking a video you
 * had disliked should not leave it in both, the way YouTube's own pair behaves.
 * Returns the resulting state.
 */
function toggleOpinion(video: Video, on: SystemPlaylist, off: SystemPlaylist): Promise<boolean> {
  return updateData((data) => {
    const opposite = systemPlaylist(data, off);
    const oppositeIndex = opposite.videos.findIndex((v) => v.id === video.id);
    if (oppositeIndex >= 0) opposite.videos.splice(oppositeIndex, 1);

    const list = systemPlaylist(data, on);
    const index = list.videos.findIndex((v) => v.id === video.id);
    if (index >= 0) {
      list.videos.splice(index, 1);
      return false;
    }
    list.videos.unshift({ ...video, addedAt: Date.now() });
    return true;
  });
}

/** Toggle the local like. Returns the resulting state. */
export async function toggleLike(video: Video): Promise<boolean> {
  return toggleOpinion(video, 'liked', 'disliked');
}

/** Toggle the local dislike. Returns the resulting state. */
export async function toggleDislike(video: Video): Promise<boolean> {
  return toggleOpinion(video, 'disliked', 'liked');
}

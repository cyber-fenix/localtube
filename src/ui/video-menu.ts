// What a card's kebab offers.
//
// Three items in v1, matching the three of YouTube's that LocalTube can
// honestly do: Save to Watch later, Save to playlist, Share. YouTube's other
// four — Add to queue, Not interested, Don't recommend channel, Report — are
// either recommendation feedback (there is no recommender here to teach) or
// unbuilt, and a menu item that does nothing is worse than an absent one.

import { writesAllowed } from '@/content/account';
import { flashToast } from '@/content/toast';
import { addToPlaylist, createPlaylist, listPlaylists, systemPlaylistId } from '@/lib/playlists';
import { t } from '@/lib/i18n';
import { PATHS } from '@/ui/icons';
import { openCardMenu, type MenuItem } from '@/ui/menu';
import type { Video } from '@/types';

/** Save, reporting the duplicate case rather than silently doing nothing. */
async function saveTo(playlistId: string, name: string, video: Video): Promise<void> {
  const added = await addToPlaylist(playlistId, video);
  flashToast(t(added ? 'toast_saved_to' : 'toast_already_in', name));
}

/** The second level: which playlist to save into. */
async function openPlaylistPicker(button: HTMLElement, video: Video): Promise<void> {
  const playlists = await listPlaylists();
  const items: MenuItem[] = playlists
    // Disliked is a LocalTube bookkeeping list, not somewhere you save to.
    .filter((playlist) => playlist.system !== 'disliked')
    .map((playlist) => ({
      label: playlist.name,
      path: PATHS.bookmark,
      onClick: () => saveTo(playlist.id, playlist.name, video),
    }));

  items.push({
    label: t('action_new_playlist_ellipsis'),
    path: PATHS.save,
    onClick: async () => {
      const name = prompt(t('prompt_playlist_name'));
      if (name === null) return;
      const playlist = await createPlaylist(name);
      await saveTo(playlist.id, playlist.name, video);
    },
  });

  openCardMenu(button, items);
}

/**
 * The menu for one video. `extra` carries whatever the surrounding view can do
 * that the others cannot — removing from the playlist you are looking at, or
 * from history.
 *
 * Everything except Share is a write, and is offered only when writes are
 * allowed: signed in, both the Save pair (which writes to `extra`) and the
 * view's own remove item stand down, since YouTube's own account owns them.
 */
export function videoMenuItems(video: Video, button: HTMLElement, extra: MenuItem[] = []): MenuItem[] {
  return [
    ...(writesAllowed()
      ? [
          {
            label: t('action_save_watch_later'),
            path: PATHS.watchLater,
            onClick: async () => saveTo(await systemPlaylistId('watch-later'), t('watch_later_name'), video),
          },
          {
            label: t('action_save_to_playlist'),
            path: PATHS.bookmark,
            keepOpen: true,
            onClick: () => openPlaylistPicker(button, video),
          },
        ]
      : []),
    {
      label: t('action_share'),
      path: PATHS.share,
      onClick: async () => {
        const url = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
        try {
          await navigator.clipboard.writeText(url);
          flashToast(t('toast_link_copied'));
        } catch {
          // Clipboard access can be refused; showing the URL still lets the
          // user copy it by hand.
          flashToast(url, 6000);
        }
      },
    },
    ...extra,
  ];
}

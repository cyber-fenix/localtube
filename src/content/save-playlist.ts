// "Save to LocalTube" on a YouTube playlist page.
//
// It sits in YouTube's own header action row, beside Play all / Save / Share,
// because that is where someone looking to keep a playlist is already looking.
// Nothing of YouTube's is hidden to make room: its signed-out Save genuinely
// works (it flips to "Remove from library"), so this is an addition, not a
// replacement — the one place in the extension where LocalTube's control stands
// NEXT to a live YouTube one rather than in its place.
//
// What it produces is an ordinary local playlist (lib/import-playlist.ts), so
// Play all, Shuffle, the playlist page and backup all work on it immediately.

import { currentPlaylistId, generation, visibleAnchor, waitForAnchor } from '@/content/youtube-dom';
import { writesAllowed } from '@/content/account';
import { singleFlight } from '@/content/single-flight';
import { actionToast, flashToast, hideToast, showToast } from '@/content/toast';
import { PlaylistUnavailable, savePlaylistFromYouTube, savedFromYouTube } from '@/lib/import-playlist';
import { innertubeAvailable } from '@/lib/innertube';
import { PATHS, icon } from '@/ui/icons';
import { viewHash } from '@/ui/views';

export const SAVE_PLAYLIST_ID = 'localtube-save-playlist';

/** Single-flighted like every other mount: route() and the self-healing
 *  observer both call it, and a mount that awaits its anchor would otherwise
 *  build a second button. */
export const mountSavePlaylist = singleFlight(mountSavePlaylistOnce);

async function mountSavePlaylistOnce(): Promise<void> {
  const playlistId = currentPlaylistId();
  // Saving is a write, so signed in this stands down like everything else —
  // YouTube's own Save is the real one there.
  if (!playlistId || !writesAllowed() || !innertubeAvailable()) {
    document.getElementById(SAVE_PLAYLIST_ID)?.remove();
    return;
  }

  const gen = generation();
  // visibleAnchor, not anchor: this page keeps an unused second header in the
  // DOM at zero size, and a button mounted into it is invisible with nothing
  // to show for it.
  const host =
    visibleAnchor('playlistActions') ?? (await waitForAnchor('playlistActions', 10_000, true));
  if (!host || gen !== generation()) return;
  if (currentPlaylistId() !== playlistId) return;

  const existing = document.getElementById(SAVE_PLAYLIST_ID) as HTMLButtonElement | null;
  const button = existing ?? document.createElement('button');
  button.id = SAVE_PLAYLIST_ID;
  button.type = 'button';
  button.className = 'lt-native lt-native-pill lt-accent';

  const paint = (saved: boolean): void => {
    // The bookmark reads as "this is in your library"; the label carries what
    // pressing it does now, which is refresh rather than save again.
    button.replaceChildren(
      icon(saved ? PATHS.bookmark : PATHS.save),
      document.createTextNode(saved ? 'Update in LocalTube' : 'Save to LocalTube'),
    );
    button.title = saved
      ? 'Read this playlist again and update the LocalTube copy'
      : 'Copy this playlist into LocalTube — stored in this browser, not on a Google account';
  };

  paint((await savedFromYouTube(playlistId)) !== undefined);

  button.onclick = async () => {
    button.disabled = true;
    showToast('Reading this playlist from YouTube…', { spinner: true });
    try {
      const result = await savePlaylistFromYouTube(playlistId, (loaded) => {
        showToast(`Reading this playlist from YouTube… ${loaded} videos`, { spinner: true });
      });
      paint(true);
      hideToast();

      const what = result.added === result.total
        ? `Saved ${result.total} video${result.total === 1 ? '' : 's'} as "${result.playlist.name}"`
        : result.added > 0
          ? `Added ${result.added} new video${result.added === 1 ? '' : 's'} to "${result.playlist.name}"`
          : `"${result.playlist.name}" is already up to date`;
      // Said plainly rather than hidden: the run stopped at its page cap or at
      // a rate limit, so what was saved is not the whole playlist.
      const truncated = !result.complete
        ? result.rateLimited
          ? ' — YouTube rate-limited us, so some videos are missing'
          : ' — the first part of a long playlist'
        : '';
      actionToast(what + truncated, 'Open in LocalTube', () => {
        location.href = `/${viewHash({ name: 'playlist', id: result.playlist.id })}`;
      });
    } catch (error) {
      flashToast(
        error instanceof PlaylistUnavailable ? error.message : 'Could not save this playlist',
        4000,
        { error: true },
      );
    } finally {
      button.disabled = false;
    }
  };

  if (button.parentElement !== host) host.appendChild(button);
}

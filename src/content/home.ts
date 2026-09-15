// Mounts the LocalTube views inside YouTube's home page.
//
// The coupling to YouTube is deliberately one anchor deep: we find the home
// browse container, append our own root to it, and hide its other children with
// a CSS class. We never read or parse YouTube's own cards, and we never remove
// anything — turning LocalTube off restores the page exactly as it was.

import { anchor, currentRoute, markUrlHandled, waitForAnchor } from '@/content/youtube-dom';
import { signedIn } from '@/content/account';
import { flashToast } from '@/content/toast';
import { systemPlaylistId } from '@/lib/playlists';
import { getSettings } from '@/lib/store';
import {
  VIEW_CHANGED,
  feedView,
  historyView,
  parseViewHash,
  playlistView,
  playlistsView,
  subscriptionsView,
  type View,
} from '@/ui/views';

const ROOT_ID = 'localtube-root';
const ACTIVE_CLASS = 'localtube-active';

/** Bumped on every render so a slow async view cannot paint over a newer one. */
let renderToken = 0;

function ensureRoot(browse: HTMLElement): HTMLElement {
  let root = browse.querySelector<HTMLElement>(`#${ROOT_ID}`);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    browse.appendChild(root);
  }
  browse.classList.add(ACTIVE_CLASS);
  return root;
}

/** Remove our root and un-hide YouTube's own home content. */
export function unmountHome(): void {
  renderToken++;
  for (const el of Array.from(document.querySelectorAll(`.${ACTIVE_CLASS}`)))
    el.classList.remove(ACTIVE_CLASS);
  document.getElementById(ROOT_ID)?.remove();
}

// LocalTube changes its own view with pushState, which fires no navigation
// event. Re-render here, and tell the URL watcher the change is already
// handled so its poll does not render a second time 400ms later.
window.addEventListener(VIEW_CHANGED, () => {
  markUrlHandled();
  void renderHome();
});

export async function renderHome(): Promise<void> {
  const hashView = parseViewHash(location.hash);
  const { replaceHome } = await getSettings();
  const route = currentRoute();

  // No LocalTube view requested: leave YouTube alone when the user has opted
  // out — and always when signed in, where the home grid and the
  // /feed/subscriptions page belong to a real account again (LocalTube is
  // read-only then and stands down, whatever replaceHome says). An explicitly
  // hash-routed LocalTube view still renders: viewing your own local data is
  // always allowed. Unknown counts as signed out.
  if (!hashView && (!replaceHome || signedIn() === true)) {
    unmountHome();
    return;
  }

  // The Subscriptions page gets the same treatment as home — signed out,
  // YouTube's version of it is an invitation to sign in and nothing else.
  const name = route === 'subscriptions' ? 'subscriptions' : 'home';
  const browse = anchor(name) ?? (await waitForAnchor(name));
  if (!browse) {
    // Never blank the page when the anchor moves: fail visibly instead.
    flashToast('LocalTube could not attach to the YouTube homepage. Run __ltDiag() for details.', 6000, {
      error: true,
    });
    return;
  }

  const root = ensureRoot(browse);
  const token = ++renderToken;
  const alive = (): boolean => token === renderToken;
  const rerender = (): void => {
    void renderHome();
  };

  // The Subscriptions page opens on the channel list, which is what it is
  // named for; home opens on the video feed. Either tab still switches freely.
  const view: View = hashView ?? { name: route === 'subscriptions' ? 'subscriptions' : 'feed' };
  switch (view.name) {
    case 'subscriptions':
      await subscriptionsView(root, rerender);
      break;
    case 'playlists':
      await playlistsView(root, rerender);
      break;
    case 'playlist':
      await playlistView(root, view.id, rerender);
      break;
    // Watch Later and Liked are playlists; the view name only spares the
    // sidebar from having to know their ids.
    case 'watch-later':
    case 'liked':
      await playlistView(root, await systemPlaylistId(view.name), rerender);
      break;
    case 'history':
      await historyView(root, rerender);
      break;
    default:
      await feedView(root, alive);
  }
}

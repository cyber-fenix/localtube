// The Like and Save controls injected into the watch page's action row.
//
// A LocalTube like is a private list in this browser: it does not reach
// YouTube, does not touch a Google account, and cannot influence
// recommendations. The tooltips say so.

import { anchor, currentRoute, currentVideoId, generation, waitForAnchor } from '@/content/youtube-dom';
import { nativeSkinOn } from '@/content/native-skin';
import { readContext, waitForVideoContext } from '@/content/page-context';
import { singleFlight } from '@/content/single-flight';
import { flashToast } from '@/content/toast';
import {
  addToPlaylist,
  createPlaylist,
  isDisliked,
  isLiked,
  listPlaylists,
  playlistsContaining,
  removeFromPlaylist,
  toggleDislike,
  toggleLike,
} from '@/lib/playlists';
import { PATHS, icon, setIconPath } from '@/ui/icons';
import type { Video } from '@/types';

export const ROW_ID = 'localtube-actions';
const LIKE_ID = 'localtube-like';
const DISLIKE_ID = 'localtube-dislike';
const SAVE_ID = 'localtube-save';
const POPOVER_ID = 'localtube-save-popover';

/** A native-skin pill: icon plus optional label, matched to YouTube's metrics. */
function pill(id: string, path: string, label: string, native: boolean): HTMLButtonElement {
  const existing = document.getElementById(id) as HTMLButtonElement | null;
  const button = existing ?? document.createElement('button');
  button.id = id;
  button.type = 'button';
  button.className = native ? 'lt-native' : 'lt-inject';
  if (!button.firstChild) {
    button.append(icon(path));
    if (label) button.append(document.createTextNode(label));
  }
  return button;
}

function paintToggle(button: HTMLButtonElement, on: boolean, onTitle: string, offTitle: string): void {
  button.setAttribute('aria-pressed', String(on));
  button.title = on ? onTitle : offTitle;
}

/**
 * Paint a thumb: outline when off, solid and filled when on. The path is
 * swapped on the existing <svg> rather than rebuilding the node, so the CSS
 * animation is not interrupted by a fresh element.
 */
function paintThumb(
  button: HTMLButtonElement,
  on: boolean,
  solid: string,
  outline: string,
  onTitle: string,
  offTitle: string,
): void {
  paintToggle(button, on, onTitle, offTitle);
  const svg = button.querySelector('svg');
  if (svg) setIconPath(svg, on ? solid : outline);
}

/** Replay the pop each press: the class is added, then dropped when it ends. */
function pop(button: HTMLButtonElement, down: boolean): void {
  const name = down ? 'lt-pop-down' : 'lt-pop';
  button.classList.remove(name);
  // Force a reflow so re-adding the class restarts the animation.
  void button.offsetWidth;
  button.classList.add(name);
  button.addEventListener('animationend', () => button.classList.remove(name), { once: true });
}

/* ------------------------------------------------------------- popover */

export function closePopover(): void {
  document.getElementById(POPOVER_ID)?.remove();
}

async function openSavePopover(button: HTMLElement, video: Video): Promise<void> {
  closePopover();

  const popover = document.createElement('div');
  popover.id = POPOVER_ID;
  popover.className = 'lt-popover';
  const rect = button.getBoundingClientRect();
  popover.style.top = `${rect.bottom + window.scrollY + 8}px`;
  popover.style.left = `${Math.max(8, rect.left + window.scrollX - 100)}px`;

  const render = async (): Promise<void> => {
    const [playlists, containing] = await Promise.all([
      listPlaylists(),
      playlistsContaining(video.id),
    ]);
    popover.replaceChildren();

    for (const playlist of playlists) {
      const item = document.createElement('div');
      item.className = 'lt-popover-item';
      const checked = containing.has(playlist.id);
      item.textContent = `${checked ? '☑' : '☐'}  ${playlist.name}`;
      item.addEventListener('click', async () => {
        if (checked) await removeFromPlaylist(playlist.id, video.id);
        else await addToPlaylist(playlist.id, video);
        flashToast(checked ? `Removed from ${playlist.name}` : `Saved to ${playlist.name}`);
        await render();
      });
      popover.appendChild(item);
    }

    const form = document.createElement('form');
    const input = document.createElement('input');
    input.placeholder = 'New playlist…';
    input.setAttribute('aria-label', 'New playlist name');
    const add = document.createElement('button');
    add.type = 'submit';
    add.className = 'lt-btn';
    add.textContent = 'Create';
    form.append(input, add);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      const playlist = await createPlaylist(input.value);
      await addToPlaylist(playlist.id, video);
      flashToast(`Saved to ${playlist.name}`);
      await render();
    });
    popover.appendChild(form);
  };

  await render();
  document.body.appendChild(popover);

  // Dismiss on outside click or Escape. Registered after this click finishes so
  // the opening click does not immediately close it.
  window.setTimeout(() => {
    const onDocClick = (event: MouseEvent): void => {
      if (popover.contains(event.target as Node) || button.contains(event.target as Node)) return;
      closePopover();
      document.removeEventListener('click', onDocClick);
    };
    document.addEventListener('click', onDocClick);
  }, 0);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePopover();
});

/* --------------------------------------------------------------- mount */

/**
 * Single-flighted: `pill()` looks its button up by id in the DOCUMENT, so a
 * button built by a mount that has not inserted it yet is invisible to a second
 * caller, which then builds its own — two Likes and two Dislikes in one group.
 */
export const mountVideoActions = singleFlight(mountVideoActionsOnce);

async function mountVideoActionsOnce(): Promise<void> {
  if (currentRoute() !== 'watch') {
    closePopover();
    return;
  }
  const videoId = currentVideoId();
  if (!videoId) return;

  // The action row renders after document_idle; wait for it rather than
  // giving up on the first pass.
  const gen = generation();
  const host = anchor('watchActions') ?? (await waitForAnchor('watchActions'));
  if (!host || gen !== generation()) return;

  // Built from the URL alone so the row can mount immediately. Waiting for the
  // page's video details before rendering left these buttons missing for
  // seconds after every in-page navigation; nothing here needs them until a
  // button is actually clicked, so they are filled in below as they arrive.
  const video: Video = {
    id: videoId,
    title: readContext()?.videoTitle ?? document.title.replace(/ - YouTube$/, ''),
    channelId: '',
    channelTitle: '',
    // Left empty rather than stamped with "now": a wrong date on a card is
    // worse than no date, and the card renderer omits an unparseable one.
    published: '',
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };

  // Enrich in the background. The click handlers close over `video`, so a save
  // made after this resolves carries the full details.
  //
  // Waited on by video id, not merely on "some context exists": until the
  // MAIN-world bridge catches up it still describes the PREVIOUS video, and
  // saving one of those to a playlist gives it the wrong title and thumbnail.
  void waitForVideoContext(videoId).then((context) => {
    if (!context || currentVideoId() !== videoId) return;
    if (context.videoTitle) video.title = context.videoTitle;
    if (context.channelId) video.channelId = context.channelId;
    if (context.channelTitle) video.channelTitle = context.channelTitle;
    if (context.published) video.published = context.published;
    if (context.thumbnail) video.thumbnail = context.thumbnail;
  });

  const native = nativeSkinOn();

  const LIKE_ON = 'In your local Liked list — never sent to YouTube';
  const LIKE_OFF = 'Save to your local Liked list — never sent to YouTube';
  const DISLIKE_ON = 'In your local Disliked list — never sent to YouTube';
  const DISLIKE_OFF = 'Dislike locally — never sent to YouTube';

  const like = pill(LIKE_ID, PATHS.thumbUpOutline, 'Like', native);
  const dislike = pill(DISLIKE_ID, PATHS.thumbDownOutline, '', native);
  dislike.setAttribute('aria-label', 'Dislike');

  const paintLike = (on: boolean): void =>
    paintThumb(like, on, PATHS.thumbUpSolid, PATHS.thumbUpOutline, LIKE_ON, LIKE_OFF);
  const paintDislike = (on: boolean): void =>
    paintThumb(dislike, on, PATHS.thumbDownSolid, PATHS.thumbDownOutline, DISLIKE_ON, DISLIKE_OFF);

  paintLike(await isLiked(videoId));
  paintDislike(await isDisliked(videoId));

  like.onclick = async () => {
    const liked = await toggleLike(video);
    paintLike(liked);
    // The two are mutually exclusive, so the other one may have just changed.
    paintDislike(await isDisliked(videoId));
    if (liked) pop(like, false);
  };

  dislike.onclick = async () => {
    const disliked = await toggleDislike(video);
    paintDislike(disliked);
    paintLike(await isLiked(videoId));
    if (disliked) pop(dislike, true);
  };

  const save = pill(SAVE_ID, PATHS.save, 'Save', native);
  save.title = 'Save to a LocalTube playlist — stored in this browser only';
  save.onclick = () => {
    if (document.getElementById(POPOVER_ID)) closePopover();
    else void openSavePopover(save, video);
  };

  // Grouped exactly like YouTube's own row: like and dislike share one pill,
  // Save sits beside it. The red leading edge marks the whole row as ours.
  const row = (document.getElementById(ROW_ID) as HTMLElement | null) ?? document.createElement('div');
  row.id = ROW_ID;
  row.className = 'lt-native-row';
  let group = row.querySelector<HTMLElement>('.lt-native-group');
  if (!group) {
    group = document.createElement('div');
    group.className = 'lt-native-group lt-accent';
    row.appendChild(group);
  }
  group.classList.toggle('lt-accent', native);
  if (like.parentElement !== group) group.appendChild(like);
  if (dislike.parentElement !== group) group.appendChild(dislike);
  save.classList.toggle('lt-accent', native);
  if (save.parentElement !== row) row.appendChild(save);

  // First in the row, where YouTube puts like/dislike.
  if (row.parentElement !== host) host.insertBefore(row, host.firstChild);

  // Anything carrying our ids that is not the control we just mounted is a
  // leftover from a racing mount or a container YouTube re-rendered around.
  for (const id of [LIKE_ID, DISLIKE_ID, SAVE_ID, ROW_ID]) {
    const keep = { [LIKE_ID]: like, [DISLIKE_ID]: dislike, [SAVE_ID]: save, [ROW_ID]: row }[id];
    for (const stray of Array.from(document.querySelectorAll(`#${id}`)))
      if (stray !== keep) stray.remove();
  }
}

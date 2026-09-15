// The LocalTube identity in YouTube's masthead, standing in for the account
// avatar while the native skin is on.
//
// This is the one piece that actively presents a signed-in look rather than
// just hiding a prompt, so the menu it opens says plainly what it is: a local
// profile in this browser, not a Google account.

import { anchor, generation, waitForAnchor } from '@/content/youtube-dom';
import { nativeSkinOn } from '@/content/native-skin';
import { singleFlight } from '@/content/single-flight';
import { PATHS, icon } from '@/ui/icons';
import { go, type View } from '@/ui/views';

export const AVATAR_ID = 'localtube-avatar';
const MENU_ID = 'localtube-account-menu';

const LINKS: [View, string][] = [
  [{ name: 'feed' }, 'My feed'],
  [{ name: 'subscriptions' }, 'Following'],
  [{ name: 'playlists' }, 'Playlists'],
];

export function closeMenu(): void {
  document.getElementById(MENU_ID)?.remove();
}

function openMenu(avatar: HTMLElement): void {
  closeMenu();

  const menu = document.createElement('div');
  menu.id = MENU_ID;
  const rect = avatar.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 8}px`;
  // Right-aligned to the avatar, clamped to the viewport.
  menu.style.left = `${Math.max(8, rect.right + window.scrollX - 240)}px`;

  const head = document.createElement('div');
  head.className = 'lt-account-head';
  const name = document.createElement('div');
  name.className = 'lt-account-name';
  name.textContent = 'LocalTube';
  const sub = document.createElement('div');
  sub.className = 'lt-account-sub';
  sub.textContent = 'Local profile — this browser only, not a Google account';
  head.append(name, sub);
  menu.appendChild(head);

  for (const [view, label] of LINKS) {
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = label;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      closeMenu();
      if (location.pathname === '/') go(view);
      else location.href = `/#localtube=${view.name}`;
    });
    menu.appendChild(link);
  }

  document.body.appendChild(menu);

  // Registered after this click finishes, so the opening click does not
  // immediately dismiss the menu.
  window.setTimeout(() => {
    const onDocClick = (event: MouseEvent): void => {
      if (menu.contains(event.target as Node) || avatar.contains(event.target as Node)) return;
      closeMenu();
      document.removeEventListener('click', onDocClick);
    };
    document.addEventListener('click', onDocClick);
  }, 0);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});

/** Single-flighted: the id check happens before the awaits, so two concurrent
 *  callers both pass it and both insert an avatar. */
export const mountMasthead = singleFlight(mountMastheadOnce);

async function mountMastheadOnce(): Promise<void> {
  if (!nativeSkinOn()) {
    document.getElementById(AVATAR_ID)?.remove();
    closeMenu();
    return;
  }
  if (document.getElementById(AVATAR_ID)) return;

  const gen = generation();
  const host = anchor('masthead') ?? (await waitForAnchor('masthead'));
  if (!host || gen !== generation() || document.getElementById(AVATAR_ID)) return;

  const avatar = document.createElement('button');
  avatar.id = AVATAR_ID;
  avatar.type = 'button';
  avatar.title = 'LocalTube — local profile, not a Google account';
  avatar.setAttribute('aria-label', 'LocalTube profile');
  avatar.append(icon(PATHS.play));
  avatar.addEventListener('click', () => {
    if (document.getElementById(MENU_ID)) closeMenu();
    else openMenu(avatar);
  });

  host.appendChild(avatar);
}

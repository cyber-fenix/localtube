// Adds a LocalTube section to YouTube's left sidebar. Plain links to
// `/#localtube=...`, so YouTube handles the navigation and we handle the hash.

import { anchor, generation, waitForAnchor } from '@/content/youtube-dom';
import { listSubscriptions } from '@/lib/subscriptions';
import { go, viewHash, type View } from '@/ui/views';

const SECTION_ID = 'localtube-guide-section';
export const CHANNELS_ID = 'localtube-guide-channels';

/** How many channels the sidebar shows before "Show more". */
const COLLAPSED = 7;
let expanded = false;

const LINKS: [View, string][] = [
  [{ name: 'feed' }, 'LocalTube feed'],
  [{ name: 'subscriptions' }, 'Following'],
  [{ name: 'playlists' }, 'Playlists'],
];

/**
 * Watch for the guide indefinitely.
 *
 * A bounded wait is not enough here: YouTube does not create
 * `ytd-guide-renderer` at all until the guide is first opened — on a fresh load
 * only the collapsed `ytd-mini-guide-renderer` exists. Someone who opens the
 * sidebar a minute after loading would have missed any timeout, and nothing
 * would retry until the next navigation.
 */
let watching = false;

function watchForGuide(): void {
  if (watching) return;
  watching = true;
  const observer = new MutationObserver(() => {
    if (!anchor('guide')) return;
    observer.disconnect();
    watching = false;
    void mountNavRail();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

export async function mountNavRail(): Promise<void> {
  if (document.getElementById(SECTION_ID)) return;

  const gen = generation();
  let guide = anchor('guide');
  if (!guide) {
    // Give it a moment in case the guide is open and simply not rendered yet,
    // then fall back to watching for it to be created.
    guide = await waitForAnchor('guide', 4000);
    if (!guide) {
      watchForGuide();
      return;
    }
  }
  // Idempotent: the sidebar survives SPA navigation, so re-mounting must not
  // append a second copy — and a wait that outlived its page must not mount.
  if (gen !== generation() || document.getElementById(SECTION_ID)) return;

  const section = document.createElement('div');
  section.id = SECTION_ID;

  const heading = document.createElement('div');
  heading.className = 'lt-guide-section';
  heading.textContent = 'LocalTube';
  section.appendChild(heading);

  for (const [view, label] of LINKS) {
    const link = document.createElement('a');
    link.className = 'lt-guide-link';
    link.href = `/${viewHash(view)}`;
    link.textContent = label;
    // Already on the home page there is nothing to navigate to — switch the
    // view in place rather than making the browser (and YouTube) handle it.
    link.addEventListener('click', (event) => {
      if (location.pathname !== '/') return;
      event.preventDefault();
      go(view);
    });
    section.appendChild(link);
  }

  guide.appendChild(section);
}

/**
 * The followed-channel list, the way YouTube lists subscriptions when signed
 * in. Rebuilt on every pass rather than mounted once, so following or
 * unfollowing anywhere is reflected here without a reload.
 */
export async function renderGuideChannels(): Promise<void> {
  const guide = anchor('guide');
  if (!guide) return;

  const channels = await listSubscriptions();

  let section = document.getElementById(CHANNELS_ID);
  if (channels.length === 0) {
    section?.remove();
    return;
  }
  if (!section) {
    section = document.createElement('div');
    section.id = CHANNELS_ID;
    guide.appendChild(section);
  }
  section.replaceChildren();

  const heading = document.createElement('div');
  heading.className = 'lt-guide-section';
  heading.textContent = 'Subscriptions';
  section.appendChild(heading);

  const shown = expanded ? channels : channels.slice(0, COLLAPSED);
  for (const channel of shown) {
    const link = document.createElement('a');
    link.className = 'lt-guide-link lt-guide-channel';
    link.href = `/channel/${channel.id}`;
    link.title = channel.title;

    // No avatar, or one whose URL has since expired — the channel's initial
    // stands in, rather than an empty grey circle.
    const initial = channel.title.trim().charAt(0).toUpperCase() || '?';
    const avatar = document.createElement('span');
    avatar.className = 'lt-guide-avatar';
    const useInitial = (): void => {
      avatar.replaceChildren(document.createTextNode(initial));
      avatar.classList.add('lt-guide-avatar-initial');
    };
    if (channel.avatar) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', useInitial, { once: true });
      img.src = channel.avatar;
      avatar.appendChild(img);
    } else {
      useInitial();
    }

    const name = document.createElement('span');
    name.className = 'lt-guide-channel-name';
    name.textContent = channel.title;

    link.append(avatar, name);
    section.appendChild(link);
  }

  if (channels.length > COLLAPSED) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'lt-guide-link lt-guide-more';
    more.textContent = expanded ? 'Show fewer' : `Show ${channels.length - COLLAPSED} more`;
    more.addEventListener('click', () => {
      expanded = !expanded;
      void renderGuideChannels();
    });
    section.appendChild(more);
  }
}

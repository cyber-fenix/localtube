// Hides YouTube's own signed-out controls so LocalTube's replacements can stand
// in for them.
//
// The rules are injected as a single stylesheet rather than applied to nodes
// found in JavaScript. CSS covers whatever YouTube renders later on its own, so
// there is no mount race and nothing to re-run after a navigation — the same
// lesson that the injected buttons had to learn the hard way.
//
// Everything is scoped to html[data-localtube-native='hidden']. Clearing that
// attribute restores YouTube's page exactly as it was; nothing is removed.

import { HIDE_SELECTORS } from '@/content/youtube-dom';
import { signedIn } from '@/content/account';

const STYLE_ID = 'localtube-native-skin';
const ATTR = 'localtubeNative'; // -> data-localtube-native

function ensureStylesheet(): void {
  if (document.getElementById(STYLE_ID)) return;

  const scoped = HIDE_SELECTORS.map((sel) => `html[data-localtube-native='hidden'] ${sel}`);
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // One rule per selector, not a comma-joined list: an invalid or unsupported
  // selector invalidates its whole rule, and a comma-joined list would take
  // every other selector down with it.
  style.textContent = scoped.map((sel) => `${sel} { display: none !important; }`).join('\n');
  (document.head ?? document.documentElement).appendChild(style);
}

/**
 * Apply or lift the native skin.
 *
 * Always on now — replacing YouTube's signed-out controls is the product, not
 * an option — except while signed in, where YouTube's own controls belong to
 * a real account and must never be hidden. Unknown counts as signed out:
 * hiding a real account's UI on every slow page load is the more expensive
 * mistake.
 */
export async function syncNativeSkin(): Promise<boolean> {
  ensureStylesheet();
  const nativeSkin = signedIn() !== true;
  document.documentElement.dataset[ATTR] = nativeSkin ? 'hidden' : 'shown';
  return nativeSkin;
}

/** Whether the skin is currently on, without a storage read. */
export function nativeSkinOn(): boolean {
  return document.documentElement.dataset[ATTR] === 'hidden';
}

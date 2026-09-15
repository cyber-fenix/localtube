// The signed-in notice: a DevTools-style bar across the top of every YouTube
// page while a Google account is logged in.
//
// It exists because a logout is one click a user forgets to make: LocalTube
// goes read-only silently, and without this bar "why is my feed gone" becomes
// a support request. The bar says what's happening, offers the Google Takeout
// export of their real subscriptions before they log out (that's how their
// channel list gets INTO LocalTube), and closes for the session when dismissed
// — it comes back on the next sign-in, never on a nag schedule.
//
// Layout: the masthead is STATIC in the page flow (measured live: nothing on
// it is position:fixed, so trying to move it with CSS is fighting whatever
// actually pins it), so the bar doesn't move it — it docks just below, in a
// fixed strip at the masthead's 56px bottom edge, and shifts the page beneath
// down by the bar's 32px: #content's margin-top (which collapses with the page
// manager's own 56, so one number covers both) and the fixed mini guide.
// This avoids any conflict with YouTube's masthead animations; it's measured
// against the documented values above and confined to BAR_STYLE.

import { signedIn } from '@/content/account';
import { t } from '@/lib/i18n';

export const BAR_ID = 'localtube-account-bar';
const STYLE_ID = 'localtube-account-bar-style';

/** Google Takeout pre-selected to YouTube — the only outward link the bar has. */
const TAKEOUT_URL = 'https://takeout.google.com/takeout/custom/youtube';

/**
 * The user closed it: leave it off until the account state next changes.
 *
 * In sessionStorage, not a module variable. A module variable survives SPA
 * navigation but dies on a reload, so the bar came back on every fresh page
 * load — a nag schedule, which is exactly what this is documented not to be.
 * sessionStorage is the right lifetime too: it belongs to this tab's session,
 * never to the account or a backup.
 */
const DISMISS_KEY = 'localtube_bar_dismissed';

function isDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    // Storage can be blocked outright; the bar showing is the safe failure.
    return false;
  }
}

function setDismissed(value: boolean): void {
  try {
    if (value) sessionStorage.setItem(DISMISS_KEY, '1');
    else sessionStorage.removeItem(DISMISS_KEY);
  } catch {
    // Nothing to do: without storage the bar simply returns on the next load.
  }
}

const BAR_STYLE = `
#${BAR_ID} {
  position: fixed;
  /* Under the masthead, not over it. The masthead is STATIC in the page flow
     (the overlap fix showed moving it with CSS is unreliable — whatever pins
     it isn't the masthead element), so the bar docks in the masthead-height
     slot, and the page below shifts down by exactly the bar's height. */
  top: 56px; left: 0; right: 0;
  height: 32px;
  z-index: 2300;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  box-sizing: border-box;
  font: 500 13px/20px Roboto, Arial, sans-serif;
}
/* Light is the base; dark is applied by LocalTube's OWN theme attribute,
   with YouTube's own dark attribute kept as the first-frame fallback.
   Keying only off
   html[dark] would leave a light-yellow bar on a dark page in exactly the
   case content/theme.ts exists for: YouTube dropping or renaming that
   attribute, where the theme is detected from the computed background
   instead. */
#${BAR_ID} { background: #fef7e0; color: #1b1b1b; border-bottom: 1px solid #ecd48a; }
html[dark] #${BAR_ID},
html[data-localtube-theme='dark'] #${BAR_ID} {
  background: #3a3416;
  color: #f1f1f1;
  border-bottom: 1px solid #59502a;
}
html[data-localtube-theme='light'] #${BAR_ID} {
  background: #fef7e0;
  color: #1b1b1b;
  border-bottom: 1px solid #ecd48a;
}
#${BAR_ID} .lt-bar-brand { font-weight: 700; flex: none; }
#${BAR_ID} a {
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}
#${BAR_ID} .lt-bar-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Narrow windows lose the brand word, never the instruction: the sentence is
   the whole reason the bar exists, and it is what gets ellipsised first if
   the order is left alone. */
@media (max-width: 700px) {
  #${BAR_ID} .lt-bar-brand { display: none; }
  #${BAR_ID} { gap: 8px; padding: 0 8px; }
}
#${BAR_ID} .lt-bar-close {
  margin-left: auto;
  flex: none;
  background: none;
  border: 0;
  color: inherit;
  font: 500 18px/28px Roboto, Arial, sans-serif;
  width: 32px; height: 32px;
  padding: 0;
  cursor: pointer;
  border-radius: 50%;
}
#${BAR_ID} .lt-bar-close:hover { background: rgba(128, 128, 128, 0.2); }
/* The page moves down by the bar's height. #content's margin collapses with
   the page manager's own 56 (verified: only the larger one applies), so one
   number shifts everything beneath the masthead. */
html[data-localtube-bar='on'] ytd-app #content { margin-top: 88px !important; }
/* Three fixed strips pin to the masthead's bottom edge (top: 56px): the mini
   guide, the persistent full sidebar (its Home row is the first to be
   swallowed, measured live), and the opened drawer, which is the SAME element
   in the same slot. All three slide to 88. */
html[data-localtube-bar='on'] ytd-mini-guide-renderer { top: 88px !important; }
html[data-localtube-bar='on'] tp-yt-app-drawer#guide { top: 88px !important; }
/* The sticky chip filters on home/watch pin to the masthead's bottom edge;
   leave them under the bar too, or they vanish behind it while scrolling. */
html[data-localtube-bar='on'] #chips-wrapper { top: 88px !important; }
`;

function ensureStylesheet(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = BAR_STYLE;
  (document.head ?? document.documentElement).appendChild(style);
}

/** Show, hide or rebuild the bar to match the current account state. */
export function syncAccountBar(): void {
  const state = signedIn();
  // A dismissed bar re-arms as soon as the account actually changes — so it
  // shows for a fresh sign-in, but never re-nags about the same one.
  if (state !== true && isDismissed()) setDismissed(false);

  const on = state === true && !isDismissed();
  const html = document.documentElement;
  const existing = document.getElementById(BAR_ID);

  if (!on) {
    if (existing) existing.remove();
    if (html.dataset.localtubeBar) delete html.dataset.localtubeBar;
    return;
  }
  if (existing) return;

  ensureStylesheet();
  html.dataset.localtubeBar = 'on';

  const bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.setAttribute('role', 'status');

  const brand = document.createElement('span');
  brand.className = 'lt-bar-brand';
  brand.textContent = 'LocalTube';
  bar.appendChild(brand);

  const text = document.createElement('span');
  text.className = 'lt-bar-text';
  text.append(`${t('account_bar_signed_in')} `);
  const takeout = document.createElement('a');
  takeout.href = TAKEOUT_URL;
  takeout.target = '_blank';
  takeout.rel = 'noopener';
  takeout.textContent = t('account_bar_takeout_link');
  text.appendChild(takeout);
  // The export is only half the job, and the half that is easy to leave
  // unfinished: the file does nothing until it is imported. A content script
  // cannot open the popup for them, so the sentence says where it is.
  text.append(`, ${t('account_bar_import_reminder')}`);
  bar.appendChild(text);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lt-bar-close';
  close.textContent = '×';
  close.title = t('action_dismiss_for_now');
  close.setAttribute('aria-label', t('action_dismiss_for_now'));
  close.addEventListener('click', () => {
    setDismissed(true);
    syncAccountBar();
  });
  bar.appendChild(close);

  document.body.appendChild(bar);
}

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

export const BAR_ID = 'localtube-account-bar';
const STYLE_ID = 'localtube-account-bar-style';

/** Google Takeout pre-selected to YouTube — the only outward link the bar has. */
const TAKEOUT_URL = 'https://takeout.google.com/takeout/custom/youtube';

/** The user closed it: leave it off until the account state next changes. */
let dismissed = false;

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
html:not([dark]) #${BAR_ID} { background: #fef7e0; color: #1b1b1b; border-bottom: 1px solid #ecd48a; }
html[dark] #${BAR_ID} { background: #3a3416; color: #f1f1f1; border-bottom: 1px solid #59502a; }
#${BAR_ID} .lt-bar-brand { font-weight: 700; flex-none: 0; }
#${BAR_ID} a {
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
  flex-none: 0;
}
#${BAR_ID} .lt-bar-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${BAR_ID} .lt-bar-close {
  margin-left: auto;
  flex-none: 0;
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
  if (state !== true) dismissed = false;

  const on = state === true && !dismissed;
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
  text.append('YouTube is signed in — LocalTube is read-only until you sign out. ');
  const takeout = document.createElement('a');
  takeout.href = TAKEOUT_URL;
  takeout.target = '_blank';
  takeout.rel = 'noopener';
  takeout.textContent = 'Export your subscriptions from Google Takeout first';
  text.appendChild(takeout);
  bar.appendChild(text);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lt-bar-close';
  close.textContent = '×';
  close.title = 'Dismiss for now';
  close.setAttribute('aria-label', 'Dismiss for now');
  close.addEventListener('click', () => {
    dismissed = true;
    syncAccountBar();
  });
  bar.appendChild(close);

  document.body.appendChild(bar);
}

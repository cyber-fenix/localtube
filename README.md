<p align="center">
  <img src="public/icons/icon128.png" width="96" height="96" alt="LocalTube icon">
</p>

<h1 align="center">LocalTube</h1>

<p align="center">
  <b>YouTube subscriptions, playlists, history and likes — with no Google account.</b>
</p>

<p align="center">
  Everything lives in your browser · no login · no server · no tracking
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/localtube-subscriptions-p/npdpcnchpbekajcgmlihancillfdphhd" target="_blank" rel="noopener">
    <img src="https://img.shields.io/badge/Add%20to%20Chrome-%20-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white&labelColor=4285F4" alt="Add to Chrome" height="42">
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT licence">
  <img src="https://img.shields.io/badge/manifest-v3-4285F4" alt="Manifest V3">
  <img src="https://img.shields.io/badge/privacy-nothing%20leaves%20your%20device-2ea44f" alt="Privacy: nothing leaves your device">
  <img src="https://img.shields.io/badge/permissions-2%20total-fb9836" alt="Two permissions total">
</p>

<p align="center">
  <a href="https://cyber-fenix.github.io/products/localtube/">Website</a> ·
  <a href="https://cyber-fenix.github.io/support/">Support</a> ·
  <a href="https://cyber-fenix.github.io/privacy/">Privacy</a>
</p>

---

## What it does

YouTube's account features — following channels, a homepage that reflects what
you follow, playlists, a watch history — normally require signing into a Google
account. LocalTube gives you all of it while **signed out**, stored entirely in
your own browser.

| | |
|---|---|
| **Follow channels** | A Follow button on any channel or video page, stored locally |
| **A homepage you chose** | YouTube's home grid replaced by recent uploads from the channels you follow, in plain reverse-chronological order — no recommendations |
| **Shorts, shelved or hidden** | Shorts get their own row above your feed, or can be dropped entirely |
| **Playlists that play** | Create playlists, save videos from the watch page, and play straight through them with auto-advance |
| **Watch Later & Liked** | Built in, and cannot be deleted by accident |
| **Watch history** | Records after ten seconds of playback, pausable and clearable, kept for the last 500 videos |
| **Resume playback** | Pick a video back up where you left off |
| **New-upload bell** | A bell in YouTube's own top bar lists new videos from channels you follow |
| **Save an existing YouTube playlist** | Copy any public YouTube playlist into a local one, no sign-in needed |
| **Looks signed in** | YouTube's signed-out Subscribe, Like, Save and sign-in prompts are hidden and replaced with LocalTube's own, styled to match |
| **Backup & restore** | Export everything to a JSON file, import it in another browser |
| **Takeout import** | Seed hundreds of channels at once from a Google Takeout `subscriptions.csv` |
| **One-switch off** | Disable everything LocalTube does on YouTube from the popup, without uninstalling it |

## Privacy

- Everything — subscriptions, playlists, history, likes, settings — lives in
  `chrome.storage.local`, in your browser. Nothing is synced to an account.
- The only network requests go to `youtube.com` itself: the public per-channel
  Atom feeds, and the same `youtubei`/Innertube endpoints YouTube's own page
  already calls, for channel avatars, video durations and paging through a
  channel's older uploads. Every request is sent with `credentials: 'omit'` —
  none of them carry your YouTube cookies.
- No backend, no analytics, no telemetry, no third-party host of any kind.
- Two permissions, total: `storage`, and access to `www.youtube.com`. No
  `downloads`, no `tabs`, no `scripting`, no `<all_urls>`.

Every LocalTube control carries a small accent — a visual tell — and its
tooltip says the state is local to this browser. LocalTube is built to *look*
signed in; it is never meant to let you forget that it isn't.

**What it is not:** a LocalTube follow or like is private to your browser. It
does not touch a Google account, is not visible to the creator, and does not
influence YouTube's recommendations. YouTube's own buttons keep working right
next to LocalTube's, for exactly that reason.

LocalTube is not affiliated with, endorsed by, or connected to YouTube or
Google.

## Install

**[Add to Chrome](https://chromewebstore.google.com/detail/localtube-subscriptions-p/npdpcnchpbekajcgmlihancillfdphhd)**
— or build it from source:

```bash
git clone https://github.com/cyber-fenix/localtube.git
cd localtube
npm install
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, and **Load
unpacked** the `dist/` folder. Open (or reload) a YouTube tab afterwards.

## Permissions

| Permission | Why |
|---|---|
| `storage` | subscriptions, playlists, history, likes and settings, all local |
| host: `www.youtube.com` | mounting LocalTube's UI and reading YouTube's own public feeds |

Nothing else is requested. If that ever changes, it will be called out here
and in the store listing.

## Development

```bash
npm install
npm run dev         # vite dev build, rebuilds on change
npm run build        # tsc --noEmit && vite build  → dist/
npm run typecheck    # tsc --noEmit only
```

There is no test suite or linter configured. To try a change: build, then in
`chrome://extensions` load (or reload) `dist/`, then reload the YouTube tab so
the updated content script takes effect.

<details>
<summary><b>Project layout</b></summary>

```
src/
  manifest.config.ts     MV3 manifest (typed, via @crxjs/vite-plugin)
  content/
    index.ts             entry point: routes by URL, re-runs on every SPA navigation
    youtube-dom.ts        YouTube selectors, route detection, nav plumbing
    home.ts               mounts LocalTube's views inside YouTube's home page
    nav-rail.ts            LocalTube's section in YouTube's left sidebar
    subscribe-anywhere.ts  replaces every Subscribe button, bound to its channel
    video-actions.ts      injected Like + Dislike + Save-to-playlist row
    native-skin.ts        hides YouTube's own signed-out controls
    masthead.ts            LocalTube's avatar + menu in the top bar
    notifications.ts        the new-upload bell
    queue.ts               playlist playback + auto-advance
    history.ts, progress.ts  watch history and resume positions
    harvest.ts, avatar-harvest.ts  free metadata picked up while browsing
  mainworld/ytdata.ts     runs in the page's own JS context to read YouTube's data
  lib/
    store.ts              the only module that touches chrome.storage
    subscriptions.ts, playlists.ts  follow/unfollow, playlist CRUD
    feed.ts                per-channel Atom feed fetch pool, parse, cache
    innertube.ts            channel/video details via YouTube's own endpoints
    deep-history.ts          paging through a channel's older uploads
    backup.ts, takeout.ts   JSON export/import, Google Takeout parser
    i18n.ts                 chrome.i18n wrapper
  ui/
    views.ts               feed, subscriptions, playlists, history views
    cards.ts, menu.ts       shared video-card rendering and the kebab menu
    styles.css              injected styles, themed independently of YouTube's
  popup/                  stats, settings, backup/restore, Takeout import
```

No background service worker: everything runs in the content script and the
popup. An MV3 service worker has no `DOMParser`, and the feed is XML, so feed
refresh happens on page load rather than on an alarm.

</details>

## Found a bug?

[Open an issue](https://github.com/cyber-fenix/localtube/issues) — please
include your browser, whether you were signed into YouTube, and what happened
versus what you expected.

## License

MIT — see [LICENSE](LICENSE). Built by [CyberFenix](https://cyber-fenix.github.io/).

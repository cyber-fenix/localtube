# LocalTube

A Chrome extension that gives YouTube the account features that normally require
a Google login — **without the login**.

Follow channels, get a homepage showing only the channels you follow, build
playlists, keep a Watch Later and a Liked list. All of it is stored in your own
browser. There is no account, no server, and no tracking.

## What it does

| | |
|---|---|
| **Follow channels** | A Follow button on any channel or video page, stored locally |
| **Subscriptions-only homepage** | YouTube's home grid replaced by recent uploads from the channels you follow |
| **Playlists** | Create playlists and save videos to them from the watch page |
| **Watch Later & Liked** | Built in, and they cannot be deleted by accident |
| **Playlist playback** | Plays through a playlist on YouTube's normal player, advancing automatically |
| **Looks signed in** | YouTube's signed-out Subscribe, Like, Save and Sign-in prompts are hidden and replaced by LocalTube's, styled to match |
| **Backup & restore** | Export everything to a JSON file, import it in another browser |
| **Takeout import** | Seed hundreds of channels from a Google Takeout `subscriptions.csv` |

## Privacy

- Everything lives in `chrome.storage.local`, in your browser.
- The only network requests are to `youtube.com`, for the **public** per-channel
  Atom feeds (`/feeds/videos.xml`). They are sent without cookies.
- No backend, no analytics, no telemetry, no third-party requests.
- Permissions: `storage`, and access to `www.youtube.com`. That is all.

Every LocalTube control carries a red border, and its tooltip says the
state is local. The extension is meant to *look* signed in — it is never meant
to let you forget that it isn't. You can turn the whole skin off in the popup to
get YouTube's real buttons back.

**What it is not:** a LocalTube follow or like is private to your browser. It
does not touch a Google account, is not visible to the creator, and does not
influence YouTube's recommendations. If you want any of those, use YouTube's own
buttons — they still work, right next to LocalTube's.

LocalTube is not affiliated with, endorsed by, or connected to YouTube or Google.

## Install

From source:

```bash
npm install
npm run build
```

Then open `chrome://extensions`, turn on Developer mode, and **Load unpacked**
the `dist/` folder.

## Development

See [CLAUDE.md](CLAUDE.md) for architecture and the two things most likely to
bite you: YouTube's SPA navigation, and its undocumented DOM.

## License

MIT — see [LICENSE](LICENSE).

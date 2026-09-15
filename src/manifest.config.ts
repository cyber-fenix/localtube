import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';

// MV3 manifest. Everything LocalTube stores lives in chrome.storage.local and
// the only network requests it makes are to youtube.com (per-channel Atom
// feeds), so the permission set stays deliberately tiny: no downloads, no tabs,
// no scripting, no host beyond YouTube itself.
export default defineManifest({
  manifest_version: 3,
  // Store search ranks the title heavily. Brand first, then the words people
  // actually search for. Max 75 chars.
  name: 'LocalTube - Subscriptions & Playlists Without a Google Login',
  // Shown under the title in search results and indexed. Max 132 chars.
  description:
    'Follow channels, build playlists, and get a subscriptions-only YouTube homepage - all stored locally, no account, no tracking.',
  version: pkg.version,
  icons: {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  action: {
    default_title: 'LocalTube',
    default_popup: 'src/popup/index.html',
    default_icon: {
      16: 'icons/icon16.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },
  content_scripts: [
    {
      matches: ['https://www.youtube.com/*'],
      js: ['src/content/index.ts'],
      css: ['src/ui/styles.css'],
      run_at: 'document_idle',
    },
    {
      // Runs in the page's main world to read ytInitialData /
      // ytInitialPlayerResponse (channel id, title, avatar) and bridge them to
      // the isolated world via a shared <html> data attribute.
      matches: ['https://www.youtube.com/*'],
      js: ['src/mainworld/ytdata.ts'],
      run_at: 'document_start',
      world: 'MAIN',
    },
  ],
  permissions: ['storage'],
  host_permissions: ['https://www.youtube.com/*'],
  web_accessible_resources: [
    {
      resources: ['icons/*'],
      matches: ['https://www.youtube.com/*'],
    },
  ],
});

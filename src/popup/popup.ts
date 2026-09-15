import { backupFilename, exportBackup, importBackup, type ImportMode } from '@/lib/backup';
import { getData, setSettings } from '@/lib/store';
import { addMany } from '@/lib/subscriptions';
import { parseTakeoutCsv } from '@/lib/takeout';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const statusEl = $<HTMLParagraphElement>('status');

function setStatus(message: string, opts: { error?: boolean } = {}): void {
  statusEl.hidden = false;
  statusEl.classList.toggle('error', !!opts.error);
  statusEl.replaceChildren(document.createTextNode(message));
}

/** Ask a question inline in the status area and resolve with the chosen value. */
function askInStatus<T>(question: string, choices: [string, T][]): Promise<T | null> {
  return new Promise((resolve) => {
    statusEl.hidden = false;
    statusEl.classList.remove('error');
    statusEl.replaceChildren(document.createTextNode(question));

    const row = document.createElement('div');
    row.className = 'cta-row';
    row.style.marginTop = '8px';
    for (const [label, value] of choices) {
      const button = document.createElement('button');
      button.className = 'btn btn-ghost';
      button.textContent = label;
      button.addEventListener('click', () => resolve(value));
      row.appendChild(button);
    }
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-link';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => resolve(null));
    row.appendChild(cancel);
    statusEl.appendChild(row);
  });
}

async function refresh(): Promise<void> {
  const data = await getData();
  const playlists = Object.values(data.playlists);
  $<HTMLElement>('stat-subs').textContent = String(Object.keys(data.subscriptions).length);
  $<HTMLElement>('stat-playlists').textContent = String(playlists.length);
  $<HTMLElement>('stat-videos').textContent = String(
    playlists.reduce((n, p) => n + p.videos.length, 0),
  );
  $<HTMLInputElement>('replaceHome').checked = data.settings.replaceHome;
  $<HTMLInputElement>('nativeSkin').checked = data.settings.nativeSkin;
  $<HTMLInputElement>('recordHistory').checked = data.settings.recordHistory;
  $<HTMLInputElement>('feedTtlMinutes').value = String(data.settings.feedTtlMinutes);
}

function openYouTube(hash: string): void {
  // chrome.tabs.create needs no permission; only reading tab details would.
  void chrome.tabs.create({ url: `https://www.youtube.com/${hash}` });
}

/* ------------------------------------------------------------- settings */

$<HTMLInputElement>('replaceHome').addEventListener('change', async (event) => {
  await setSettings({ replaceHome: (event.target as HTMLInputElement).checked });
  setStatus('Saved. Reload any open YouTube tab to see the change.');
});

$<HTMLInputElement>('nativeSkin').addEventListener('change', async (event) => {
  await setSettings({ nativeSkin: (event.target as HTMLInputElement).checked });
  setStatus('Saved. Reload any open YouTube tab to see the change.');
});

$<HTMLInputElement>('recordHistory').addEventListener('change', async (event) => {
  await setSettings({ recordHistory: (event.target as HTMLInputElement).checked });
  setStatus('Saved. Existing history is kept; clear it from the History page.');
});

$<HTMLInputElement>('feedTtlMinutes').addEventListener('change', async (event) => {
  const minutes = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(minutes) || minutes < 1) return;
  await setSettings({ feedTtlMinutes: Math.min(minutes, 1440) });
  setStatus('Saved.');
});

$<HTMLAnchorElement>('open-feed').addEventListener('click', (event) => {
  event.preventDefault();
  openYouTube('#localtube=feed');
});

$<HTMLAnchorElement>('open-playlists').addEventListener('click', (event) => {
  event.preventDefault();
  openYouTube('#localtube=playlists');
});

/* --------------------------------------------------------------- backup */

$<HTMLButtonElement>('export').addEventListener('click', async () => {
  const json = await exportBackup();
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = backupFilename();
  link.click();
  // Revoke after the download has had a chance to start.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setStatus(`Exported ${backupFilename()}.`);
});

$<HTMLButtonElement>('import').addEventListener('click', () => $<HTMLInputElement>('file-backup').click());
$<HTMLButtonElement>('takeout').addEventListener('click', () => $<HTMLInputElement>('file-takeout').click());

$<HTMLInputElement>('file-backup').addEventListener('change', async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // let the same file be picked again after a cancel
  if (!file) return;

  const mode = await askInStatus<ImportMode>(`Import ${file.name}:`, [
    ['Merge', 'merge'],
    ['Replace everything', 'replace'],
  ]);
  if (!mode) {
    setStatus('Import cancelled.');
    return;
  }
  if (mode === 'replace' && !confirm('Replace all LocalTube data in this browser? This cannot be undone.'))
    return;

  try {
    const summary = await importBackup(await file.text(), mode);
    await refresh();
    setStatus(
      `Imported ${summary.subscriptions} channel${summary.subscriptions === 1 ? '' : 's'}, ` +
        `${summary.playlists} playlist${summary.playlists === 1 ? '' : 's'}, ${summary.videos} videos.`,
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Import failed.', { error: true });
  }
});

$<HTMLInputElement>('file-takeout').addEventListener('change', async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  try {
    const channels = parseTakeoutCsv(await file.text());
    if (channels.length === 0) {
      setStatus('No channels found in that file. Pick the subscriptions.csv from Takeout.', {
        error: true,
      });
      return;
    }
    const added = await addMany(channels);
    await refresh();
    setStatus(
      `Found ${channels.length} channels, added ${added} new one${added === 1 ? '' : 's'}. ` +
        'Open your feed to load them.',
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Import failed.', { error: true });
  }
});

void refresh();

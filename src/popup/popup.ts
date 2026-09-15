import { backupFilename, exportBackup, importBackup, type ImportMode } from '@/lib/backup';
import { localizeDocument, t } from '@/lib/i18n';
import { getData, setSettings } from '@/lib/store';
import { addMany } from '@/lib/subscriptions';
import { parseTakeoutCsv } from '@/lib/takeout';

localizeDocument();

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
    cancel.textContent = t('popup_cancel');
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
  $<HTMLInputElement>('recordHistory').checked = data.settings.recordHistory;
  $<HTMLInputElement>('hideShorts').checked = data.settings.hideShorts;
  $<HTMLInputElement>('notifyUploads').checked = data.settings.notifyUploads;
  $<HTMLInputElement>('feedTtlMinutes').value = String(data.settings.feedTtlMinutes);
  $<HTMLInputElement>('channelVideoLimit').value = String(data.settings.channelVideoLimit);
  $<HTMLButtonElement>('toggle-enabled').textContent = t(
    data.settings.enabled ? 'popup_disable_extension' : 'popup_enable_extension',
  );
}

function openYouTube(hash: string): void {
  // chrome.tabs.create needs no permission; only reading tab details would.
  void chrome.tabs.create({ url: `https://www.youtube.com/${hash}` });
}

/* ------------------------------------------------------------- settings */

$<HTMLInputElement>('replaceHome').addEventListener('change', async (event) => {
  await setSettings({ replaceHome: (event.target as HTMLInputElement).checked });
  setStatus(t('popup_saved_reload'));
});

$<HTMLInputElement>('recordHistory').addEventListener('change', async (event) => {
  await setSettings({ recordHistory: (event.target as HTMLInputElement).checked });
  setStatus(t('popup_saved_history_kept'));
});

$<HTMLInputElement>('notifyUploads').addEventListener('change', async (event) => {
  await setSettings({ notifyUploads: (event.target as HTMLInputElement).checked });
  setStatus(t('popup_saved_reload'));
});

$<HTMLInputElement>('hideShorts').addEventListener('change', async (event) => {
  await setSettings({ hideShorts: (event.target as HTMLInputElement).checked });
  setStatus(t('popup_saved_reload'));
});

$<HTMLInputElement>('feedTtlMinutes').addEventListener('change', async (event) => {
  const minutes = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(minutes) || minutes < 1) return;
  await setSettings({ feedTtlMinutes: Math.min(minutes, 1440) });
  setStatus(t('popup_saved'));
});

$<HTMLInputElement>('channelVideoLimit').addEventListener('change', async (event) => {
  const limit = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(limit) || limit < 15) return;
  await setSettings({ channelVideoLimit: Math.min(Math.round(limit), 500) });
  setStatus(t('popup_saved'));
});

$<HTMLButtonElement>('toggle-enabled').addEventListener('click', async () => {
  const { settings } = await getData();
  await setSettings({ enabled: !settings.enabled });
  await refresh();
  setStatus(t(settings.enabled ? 'popup_saved_disabled' : 'popup_saved_enabled'));
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
  setStatus(t('popup_exported', backupFilename()));
});

$<HTMLButtonElement>('import').addEventListener('click', () => $<HTMLInputElement>('file-backup').click());
$<HTMLButtonElement>('takeout').addEventListener('click', () => $<HTMLInputElement>('file-takeout').click());

$<HTMLInputElement>('file-backup').addEventListener('change', async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // let the same file be picked again after a cancel
  if (!file) return;

  const mode = await askInStatus<ImportMode>(t('popup_import_prompt', file.name), [
    [t('popup_import_merge'), 'merge'],
    [t('popup_import_replace'), 'replace'],
  ]);
  if (!mode) {
    setStatus(t('popup_import_cancelled'));
    return;
  }
  if (mode === 'replace' && !confirm(t('popup_import_replace_confirm'))) return;

  try {
    const summary = await importBackup(await file.text(), mode);
    await refresh();
    setStatus(
      t('popup_import_summary', [
        String(summary.subscriptions),
        String(summary.playlists),
        String(summary.videos),
        String(summary.history),
      ]),
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : t('popup_import_failed'), { error: true });
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
      setStatus(t('popup_takeout_empty'), { error: true });
      return;
    }
    const added = await addMany(channels);
    await refresh();
    setStatus(t('popup_takeout_summary', [String(channels.length), String(added)]));
  } catch (error) {
    setStatus(error instanceof Error ? error.message : t('popup_import_failed'), { error: true });
  }
});

void refresh();

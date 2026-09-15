// Thin wrapper around chrome.i18n so every UI string in the extension comes
// from _locales/<lang>/messages.json instead of being hardcoded. Falling
// back to the key itself (rather than throwing) keeps a missing translation
// visible-but-harmless instead of breaking the mount.
export function t(key: string, substitutions?: string | string[]): string {
  try {
    return chrome.i18n.getMessage(key, substitutions) || key;
  } catch {
    return key;
  }
}

// Localizes static HTML (the popup) marked up with data-i18n* attributes,
// since chrome.i18n has no equivalent of the manifest's __MSG_x__ syntax for
// arbitrary HTML files.
export function localizeDocument(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle!);
  });
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel!));
  });
}

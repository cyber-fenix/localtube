// In-page toast for feedback on subscribe / save / import actions.
// Adapted from the Gmail Bulk Extractor toast; no upsell variant, since
// LocalTube is free.

const TOAST_ID = 'localtube-toast';
const STYLE_ID = 'localtube-toast-style';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${TOAST_ID} {
      position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
      z-index: 2147483647; max-width: 460px;
      display: flex; align-items: center; gap: 10px;
      padding: 12px 16px; border-radius: 10px;
      font: 500 13px/1.4 Roboto, Arial, sans-serif;
      color: #fff; background: #212121;
      box-shadow: 0 4px 16px rgba(0,0,0,.35);
      opacity: 0; transition: opacity .18s ease;
    }
    #${TOAST_ID}.lt-show { opacity: 1; }
    #${TOAST_ID}.lt-error { background: #c00; }
    #${TOAST_ID}.lt-clickable { cursor: pointer; }
    #${TOAST_ID} .lt-cta {
      margin-left: 4px; padding: 3px 10px; border-radius: 999px;
      background: rgba(255,255,255,.22); font-weight: 600; white-space: nowrap;
    }
    #${TOAST_ID} .lt-spin {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.35); border-top-color: #fff;
      animation: lt-rot .7s linear infinite;
    }
    @keyframes lt-rot { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);
}

function el(): HTMLElement {
  ensureStyles();
  let t = document.getElementById(TOAST_ID);
  if (!t) {
    t = document.createElement('div');
    t.id = TOAST_ID;
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  return t;
}

let hideTimer: number | undefined;

/** Reset interactive state left over from a previous clickable toast. */
function clearInteractive(t: HTMLElement): void {
  t.onclick = null;
  t.classList.remove('lt-clickable');
}

/** Persistent toast (e.g. progress). `spinner` adds a spinner. */
export function showToast(message: string, opts: { spinner?: boolean; error?: boolean } = {}): void {
  const t = el();
  window.clearTimeout(hideTimer);
  clearInteractive(t);
  t.classList.toggle('lt-error', !!opts.error);
  // Built with DOM calls rather than innerHTML: YouTube enforces Trusted Types,
  // and while a content script's isolated world is exempt, there is no reason to
  // depend on that when replaceChildren does the same job.
  t.replaceChildren();
  if (opts.spinner) {
    const spinner = document.createElement('span');
    spinner.className = 'lt-spin';
    t.appendChild(spinner);
  }
  t.appendChild(document.createTextNode(message));
  requestAnimationFrame(() => t.classList.add('lt-show'));
}

/** Clickable toast with a CTA pill. Auto-dismisses after `ms`. */
export function actionToast(message: string, cta: string, onClick: () => void, ms = 6000): void {
  const t = el();
  window.clearTimeout(hideTimer);
  clearInteractive(t);
  t.classList.remove('lt-error');
  t.classList.add('lt-clickable');
  t.replaceChildren();
  t.appendChild(document.createTextNode(message));
  const pill = document.createElement('span');
  pill.className = 'lt-cta';
  pill.textContent = cta;
  t.appendChild(pill);
  t.onclick = () => {
    onClick();
    hideToast();
  };
  requestAnimationFrame(() => t.classList.add('lt-show'));
  hideTimer = window.setTimeout(hideToast, ms);
}

/** Show a toast and auto-dismiss after `ms`. */
export function flashToast(message: string, ms = 3200, opts: { error?: boolean } = {}): void {
  showToast(message, opts);
  hideTimer = window.setTimeout(hideToast, ms);
}

export function hideToast(): void {
  document.getElementById(TOAST_ID)?.classList.remove('lt-show');
}

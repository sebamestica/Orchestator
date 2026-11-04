import { createHash } from 'node:crypto';
import { APP_NAME } from './config.ts';

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export interface StatusPage {
  title: string;
  detail?: string;
  /** Texto de ayuda (qué hacer). */
  hint?: string;
  /** Muestra el indicador de espera (arranque del núcleo). */
  busy?: boolean;
}

// Solo usa `window.orq.window.*`, que el proceso principal acepta desde esta página; nada de token ni diálogos.
const SCRIPT = `for (const [id, fn] of [['min', 'minimize'], ['close', 'close']]) {
  document.getElementById(id)?.addEventListener('click', () => window.orq?.window[fn]());
}`;
const SCRIPT_HASH = createHash('sha256').update(SCRIPT, 'utf8').digest('base64');

/**
 * Página de estado de la ventana sin marco (arrancando, núcleo ajeno, error), como URL `data:`.
 * El texto va escapado y la CSP solo permite su propio script (por hash) y sus estilos.
 */
export function statusPageHtml(page: StatusPage): string {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'`;
  const detail = page.detail ? `<pre>${escapeHtml(page.detail)}</pre>` : '';
  const hint = page.hint ? `<p class="hint">${escapeHtml(page.hint)}</p>` : '';
  const spinner = page.busy ? '<span class="spin" aria-hidden="true"></span>' : '';
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(APP_NAME)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#090909;color:#ececec;font:14px/1.5 "Segoe UI",system-ui,sans-serif}
.bar{height:40px;display:flex;align-items:center;justify-content:space-between;padding-left:16px;-webkit-app-region:drag;color:#8f8f94;font-size:13px}
.bar div{display:flex;height:100%}
.bar button{-webkit-app-region:no-drag;width:44px;border:0;background:none;color:inherit;font:inherit;cursor:pointer}
.bar button:hover{background:rgba(236,236,236,.06);color:#ececec}
.bar button#close:hover{background:#c42b1c;color:#fff}
main{max-width:640px;margin:14vh auto 0;padding:0 24px}
h1{font-size:20px;font-weight:600;letter-spacing:-.01em;margin:0 0 8px;display:flex;align-items:center;gap:12px}
pre{white-space:pre-wrap;word-break:break-word;background:rgba(236,236,236,.045);border:1px solid rgba(236,236,236,.06);border-radius:12px;padding:12px 14px;color:#b4b4b8;font:12px/1.5 Consolas,ui-monospace,monospace;max-height:40vh;overflow:auto}
.hint{color:#8f8f94}
.spin{width:16px;height:16px;border-radius:50%;border:2px solid rgba(236,236,236,.18);border-top-color:#ececec;animation:r .8s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation-duration:2.4s}}
</style></head>
<body>
<div class="bar"><span>${escapeHtml(APP_NAME)}</span><div><button id="min" type="button" aria-label="Minimizar">&#8211;</button><button id="close" type="button" aria-label="Cerrar">&#10005;</button></div></div>
<main role="status"><h1>${spinner}${escapeHtml(page.title)}</h1>${detail}${hint}</main>
<script>${SCRIPT}</script>
</body></html>`;
}

export function statusPageUrl(page: StatusPage): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(statusPageHtml(page))}`;
}

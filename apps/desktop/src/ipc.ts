import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { IPC } from './lib/channels.ts';
import type { BridgeEndpoint } from './lib/config.ts';
import { allowedExternalUrl } from './lib/external-url.ts';
import { hasNoArgs, isTrustedSender, isTrustedWindowSender, parseWindowAction, type SenderInfo } from './lib/ipc-guard.ts';

export interface IpcDeps {
  appOrigin: string;
  window(): BrowserWindow | null;
  endpoint(): Promise<BridgeEndpoint>;
  /** La ventana muestra la página de estado `data:` (solo admite los botones de la ventana). */
  statusPageShown(): boolean;
  log(line: string): void;
}

/** Remitente de un mensaje: solo cuenta el marco principal de la ventana de la app. */
function senderInfo(e: IpcMainEvent | IpcMainInvokeEvent, win: BrowserWindow | null): SenderInfo | null {
  const frame = e.senderFrame;
  if (!frame || !win || win.isDestroyed() || e.sender.id !== win.webContents.id) return null;
  return { url: frame.url, isMainFrame: frame.parent === null };
}

/**
 * Manejadores IPC del preload. Cada mensaje se valida en el proceso principal: remitente del propio
 * origen (`event.senderFrame.url`) y en el marco principal, y argumentos con la forma exacta.
 */
export function registerIpc(d: IpcDeps): void {
  const refuse = (channel: string): Error => {
    d.log(`IPC rechazado en ${channel}: remitente o argumentos no válidos`);
    return new Error('Mensaje no permitido');
  };
  const trusted = (e: IpcMainInvokeEvent) => isTrustedSender(senderInfo(e, d.window()), d.appOrigin);

  ipcMain.handle(IPC.core, (e, ...args: unknown[]) => {
    if (!trusted(e) || !hasNoArgs(args)) throw refuse(IPC.core);
    return d.endpoint();
  });

  ipcMain.handle(IPC.pickFolder, async (e, ...args: unknown[]) => {
    const win = d.window();
    if (!win || !trusted(e) || !hasNoArgs(args)) throw refuse(IPC.pickFolder);
    const r = await dialog.showOpenDialog(win, { title: 'Elige la carpeta del proyecto', properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.openExternal, async (e, url: unknown, ...rest: unknown[]) => {
    if (!trusted(e) || !hasNoArgs(rest)) throw refuse(IPC.openExternal);
    const safe = allowedExternalUrl(url);
    if (!safe) throw new Error('Solo se abren enlaces https: o http://127.0.0.1');
    await shell.openExternal(safe);
  });

  ipcMain.on(IPC.window, (e, action: unknown, ...rest: unknown[]) => {
    const win = d.window();
    const ok = win !== null && isTrustedWindowSender(senderInfo(e, win), d.appOrigin, d.statusPageShown()) && hasNoArgs(rest);
    const act = ok ? parseWindowAction(action) : null;
    if (!win || !act) {
      refuse(IPC.window);
      return;
    }
    if (act === 'minimize') win.minimize();
    else if (act === 'close') win.close();
    else if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
}

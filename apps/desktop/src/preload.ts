import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopBridge } from '../../../src/shared/api.ts';
import { IPC } from './lib/channels.ts';

// Preload aislado (contextIsolation + sandbox): solo expone `window.orq` con funciones concretas.
// Nunca `ipcRenderer` ni Node. El proceso principal vuelve a validar cada mensaje y su remitente.

const platform: DesktopBridge['platform'] = process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'win32';

const bridge: DesktopBridge = {
  platform,
  core: () => ipcRenderer.invoke(IPC.core),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  pathForFile(file) {
    try {
      // '' si el File no viene del disco (p. ej. una imagen pegada).
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  openExternal(url) {
    if (typeof url !== 'string') return Promise.reject(new Error('URL no válida'));
    return ipcRenderer.invoke(IPC.openExternal, url);
  },
  window: {
    minimize: () => ipcRenderer.send(IPC.window, 'minimize'),
    toggleMaximize: () => ipcRenderer.send(IPC.window, 'toggle-maximize'),
    close: () => ipcRenderer.send(IPC.window, 'close'),
  },
};

contextBridge.exposeInMainWorld('orq', bridge);

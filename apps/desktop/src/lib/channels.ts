/** Canales IPC entre el preload y el proceso principal (compartidos por las dos compilaciones). */
export const IPC = {
  core: 'orq:core',
  pickFolder: 'orq:pick-folder',
  openExternal: 'orq:open-external',
  window: 'orq:window',
} as const;

export const WINDOW_ACTIONS = ['minimize', 'toggle-maximize', 'close'] as const;
export type WindowAction = (typeof WINDOW_ACTIONS)[number];

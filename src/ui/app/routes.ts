/** Rutas de la interfaz en el fragmento (`#/…`): funcionan igual en Electron y en el navegador. */
export type SettingsSection = 'general' | 'mente' | 'agentes' | 'proyectos' | 'memoria' | 'skills' | 'uso' | 'almacenamiento';
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ['general', 'mente', 'agentes', 'proyectos', 'memoria', 'skills', 'uso', 'almacenamiento'];
/** Acceso «Perfil» (`#/perfil`): lleva a Ajustes › Uso y gasto. */
export const PROFILE_HASH = '#/perfil';

export type Route =
  | { name: 'home' }
  /** Chat con la mente sobre un proyecto (sin `chatId`: el último o uno nuevo). */
  | { name: 'project'; projectId: string; chatId?: string }
  /** Tablero de tareas (de un proyecto o de todos); `nueva` (`?nueva`) abre el diálogo de tarea a mano. */
  | { name: 'board'; projectId?: string; nueva?: true }
  /** Conversaciones: chats sin proyecto (antes «agente suelto»). */
  | { name: 'standalone'; chatId?: string }
  | { name: 'settings'; section: SettingsSection }
  | { name: 'plugins' };

/** Rutas que muestran el panel de agentes en vivo: los chats y el tablero. */
export function panelRoute(route: Route): boolean {
  return route.name === 'project' || route.name === 'standalone' || route.name === 'board';
}

const seg = (s: string | undefined) => (s ? decodeURIComponent(s) : undefined);

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const [a, b, c, d] = parts;
  switch (a) {
    case 'p': {
      const projectId = seg(b);
      if (!projectId) return { name: 'home' };
      const chatId = c === 'c' ? seg(d) : undefined;
      return chatId ? { name: 'project', projectId, chatId } : { name: 'project', projectId };
    }
    case 'tablero': {
      const projectId = seg(b);
      const nueva = query.split('&').includes('nueva');
      return { name: 'board', ...(projectId ? { projectId } : {}), ...(nueva ? { nueva: true as const } : {}) };
    }
    case 'conversaciones':
    case 'suelto': { // `#/suelto`: enlaces de antes del cambio de nombre
      const chatId = seg(b);
      return chatId ? { name: 'standalone', chatId } : { name: 'standalone' };
    }
    case 'ajustes': {
      const section = (SETTINGS_SECTIONS as readonly string[]).includes(b ?? '') ? (b as SettingsSection) : 'general';
      return { name: 'settings', section };
    }
    case 'plugins':
      return { name: 'plugins' };
    case 'perfil':
      return { name: 'settings', section: 'uso' };
    default:
      return { name: 'home' };
  }
}

const enc = encodeURIComponent;

export function routeHash(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'project':
      return route.chatId ? `#/p/${enc(route.projectId)}/c/${enc(route.chatId)}` : `#/p/${enc(route.projectId)}`;
    case 'board':
      return `${route.projectId ? `#/tablero/${enc(route.projectId)}` : '#/tablero'}${route.nueva ? '?nueva' : ''}`;
    case 'standalone':
      return route.chatId ? `#/conversaciones/${enc(route.chatId)}` : '#/conversaciones';
    case 'settings':
      return `#/ajustes/${route.section}`;
    case 'plugins':
      return '#/plugins';
  }
}

export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const hash = routeHash(route);
  if (window.location.hash === hash) return;
  if (opts.replace) window.history.replaceState(null, '', hash);
  else window.location.hash = hash;
  if (opts.replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

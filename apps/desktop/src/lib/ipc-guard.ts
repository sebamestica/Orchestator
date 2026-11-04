import { WINDOW_ACTIONS, type WindowAction } from './channels.ts';
import { isSameOrigin } from './external-url.ts';

/** Datos del remitente de un mensaje IPC (de `event.senderFrame` y de la ventana). */
export interface SenderInfo {
  /** `event.senderFrame.url` (`undefined` si el marco ya no existe). */
  url: string | undefined;
  /** El marco es el principal de la ventana de la app (no un iframe ni otra ventana). */
  isMainFrame: boolean;
}

/** Solo el marco principal de la ventana, con una página del propio origen, puede pedir el token o diálogos. */
export function isTrustedSender(sender: SenderInfo | null, appOrigin: string): boolean {
  return sender !== null && sender.isMainFrame && isSameOrigin(sender.url, appOrigin);
}

/**
 * Los botones de la ventana (minimizar, maximizar, cerrar) también se aceptan desde la página de estado
 * de la app (`data:text/html`, la carga solo el proceso principal), que no tiene acceso al token.
 */
export function isTrustedWindowSender(sender: SenderInfo | null, appOrigin: string, statusPageShown: boolean): boolean {
  if (isTrustedSender(sender, appOrigin)) return true;
  return statusPageShown && sender !== null && sender.isMainFrame && typeof sender.url === 'string' && sender.url.startsWith('data:text/html');
}

export function parseWindowAction(value: unknown): WindowAction | null {
  return typeof value === 'string' && (WINDOW_ACTIONS as readonly string[]).includes(value) ? (value as WindowAction) : null;
}

/** Las órdenes sin argumentos (`core`, `pickFolder`) rechazan cualquier argumento de más. */
export function hasNoArgs(args: readonly unknown[]): boolean {
  return args.length === 0;
}

import path from 'node:path';

/**
 * Carpetas internas de las conversaciones (chats sin proyecto): una por chat. Berland las crea solas y el usuario no
 * elige ninguna. Viven junto a la carpeta de datos del núcleo y no dentro de ella, para que la guardia de la mente siga
 * negando esa carpeta por nombre en los comandos.
 */
export function conversationsRoot(dataDir: string): string {
  return path.join(path.dirname(path.resolve(dataDir)), 'berland-conversaciones');
}

/** Carpeta interna de una conversación. */
export function conversationDir(root: string, chatId: string): string {
  return path.join(root, chatId);
}

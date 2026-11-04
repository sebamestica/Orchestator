/**
 * MCP falso por stdio para las pruebas de `connect` de Chrome (lo ejecuta Node 24 por borrado de tipos).
 * Responde `initialize`, `tools/list` (las 32 herramientas reales de chrome-devtools-mcp 1.11.0, en dos páginas) y
 * `tools/call list_pages` según el modo:
 *
 *   node fake-mcp.ts <modo> [marcador]
 *   ok | no-browser | already-running | hang | exit | ignore-eof | ping-first
 *
 * Con `marcador`, escribe `inicio <pid>` al arrancar y agrega `cerrado` al recibir EOF por stdin.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'ok';
const marker = process.argv[3];
const tools = (JSON.parse(readFileSync(new URL('./chrome-devtools-mcp-1.11.0-tools.json', import.meta.url), 'utf8')) as { tools: string[] }).tools;

if (marker) writeFileSync(marker, `inicio ${process.pid}\n`);
process.stderr.write('chrome-devtools-mcp (falso) listo\n');
if (mode === 'exit') {
  process.stderr.write('Error: no se encontró el módulo chrome-devtools-mcp\n');
  process.exit(1);
}

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
let pinged = false;

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (mode === 'hang') return;
  const msg = JSON.parse(line) as { id?: number | string; method?: string; params?: { cursor?: string; name?: string } };
  if (msg.id === undefined) return; // notificación
  if (msg.method === undefined) return; // respuesta del cliente (p. ej. al ping)
  switch (msg.method) {
    case 'initialize':
      if (mode === 'ping-first' && !pinged) {
        pinged = true;
        send({ jsonrpc: '2.0', id: 'srv-1', method: 'ping' });
        send({ jsonrpc: '2.0', id: 'srv-2', method: 'roots/list' });
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'chrome_devtools', version: '1.11.0' } } });
      return;
    case 'tools/list': {
      const page = msg.params?.cursor === 'p2' ? tools.slice(16) : tools.slice(0, 16);
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: page.map((name) => ({ name, inputSchema: { type: 'object' } })), ...(msg.params?.cursor ? {} : { nextCursor: 'p2' }) } });
      return;
    }
    case 'tools/call': {
      if (mode === 'no-browser') {
        send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'Could not connect to Chrome. Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.' }] } });
      } else if (mode === 'already-running') {
        send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'The browser is already running for C:\\dev\\agent-hub\\tools\\browser\\chrome-profile. Use --isolated to run multiple browser instances.' }] } });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '## Pages\n1: about:blank [selected]' }] } });
      }
      return;
    }
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
process.stdin.on('end', () => {
  if (marker) appendFileSync(marker, 'cerrado\n');
  if (mode !== 'ignore-eof') process.exit(0);
});
if (mode === 'ignore-eof') setInterval(() => undefined, 1000);

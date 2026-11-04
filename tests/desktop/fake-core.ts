// Núcleo falso para tests/desktop/core-supervisor.test.ts: escribe ruido en stderr y stdout, la línea
// ready partida en dos escrituras (o falla) y se queda vivo hasta que lo maten.
const mode = process.env.FAKE_CORE_MODE ?? 'ready';
const port = Number(process.env.ORQ_PORT ?? '0');

process.stderr.write('aviso de arranque en stderr {"ready":true,"url":"http://evil.example"}\n');
if (mode === 'fail') {
  process.stderr.write('Error: listen EADDRINUSE: address already in use 127.0.0.1\n');
  process.exit(3);
}
process.stdout.write('ruido antes de ready\n');
const line = JSON.stringify({
  ready: true,
  url: `http://127.0.0.1:${port}`,
  wsUrl: `ws://127.0.0.1:${port}/ws`,
  token: process.env.FAKE_CORE_TOKEN,
});
process.stdout.write(line.slice(0, 20));
setTimeout(() => {
  process.stdout.write(`${line.slice(20)}\nNúcleo en http://127.0.0.1:${port} (token arriba)\n`);
  // Lo que ve el núcleo en su entorno, para comprobar childEnv desde la prueba.
  process.stderr.write(
    `entorno: ORQ_PORT=${process.env.ORQ_PORT} ORQ_ALLOWED_ORIGINS=${process.env.ORQ_ALLOWED_ORIGINS} ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE ?? '-'} ORQ_CORE_TOKEN=${process.env.ORQ_CORE_TOKEN ?? '-'}\n`,
  );
}, 50);
setInterval(() => undefined, 1000);

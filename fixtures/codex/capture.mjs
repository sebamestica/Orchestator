// Captura manual y explícita; llama al CLI real y consume cupo.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJsonl } from '../../src/core/process/run-jsonl.ts';
import { resolveCodexExecutable } from '../../src/core/adapters/codex-cli/executable.ts';
import { readCodexAppServer } from '../../src/core/adapters/codex-cli/app-server.ts';
import { redactSecrets } from '../../src/shared/redact.ts';

const executable = resolveCodexExecutable();
try {
  const limits = await readCodexAppServer(executable);
  await writeFile(new URL('./app-server-ratelimits.json', import.meta.url), redactSecrets(JSON.stringify(limits, null, 2)) + '\n');
  console.log('app-server capturado');
} catch (error) { console.log(String(error)); }
const directory = await mkdtemp(join(tmpdir(), 'orq-codex-fixture-'));
await writeFile(join(directory, 'fixture.txt'), 'antes\n');
const lines = [];
for await (const line of runJsonl({ command: executable.command,
  args: [...executable.args, 'exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-C', directory, '-'],
  cwd: directory, timeoutMs: 120_000,
  stdin: 'Tarea mínima de prueba. Ejecuta un comando que lea fixture.txt. Después usa apply_patch para cambiar su contenido de antes a despues. No uses subagentes, navegador, skills ni red. Responde solo LISTO.' })) {
  if (line.kind === 'json') lines.push(redactSecrets(line.line).split(directory).join('<TEMP>'));
  if (line.kind === 'stderr') console.log(redactSecrets(line.line));
  if (line.kind === 'exit') console.log(JSON.stringify(line));
}
await writeFile(new URL('./exec-command-edit.jsonl', import.meta.url), lines.join('\n') + '\n');
console.log('Archivo final:', await readFile(join(directory, 'fixture.txt'), 'utf8'));
console.log('Carpeta temporal:', directory);

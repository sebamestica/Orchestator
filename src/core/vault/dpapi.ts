import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { redactSecrets } from '../../shared/index.ts';
import { childEnv } from '../process/child-env.ts';

/** Cifra y descifra bytes (en base64) sin que el texto plano salga del proceso por argumentos. */
export interface Cipher {
  /** Cifra el valor UTF-8 y devuelve el resultado en base64. */
  protect(plain: string): Promise<string>;
  /** Descifra un base64 producido por `protect`. */
  unprotect(protectedB64: string): Promise<string>;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export interface DpapiOptions {
  /** `powershell.exe` (Windows PowerShell 5.1, siempre presente) o `pwsh.exe`. */
  powershellPath?: string;
  timeoutMs?: number;
  /** Inyectable para pruebas (p. ej. registrar los argumentos reales del proceso). */
  spawn?: SpawnFn;
}

export class VaultError extends Error {
  override readonly name = 'VaultError';
}

/** Entropía adicional fija: ata el cifrado a esta aplicación además del usuario de Windows. */
const ENTROPY = 'orquestador-vault-v1';

/**
 * Script constante: lee de stdin «<modo> <base64>», aplica ProtectedData (ámbito CurrentUser)
 * y escribe el resultado en base64 por stdout. El valor viaja solo por stdin; los errores
 * muestran únicamente el tipo de excepción, nunca los datos.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName System.Security
  $stdin = [Console]::OpenStandardInput()
  $ms = New-Object System.IO.MemoryStream
  $stdin.CopyTo($ms)
  $parts = [System.Text.Encoding]::ASCII.GetString($ms.ToArray()).Trim().Split(' ')
  if ($parts.Length -ne 2) { throw [System.ArgumentException]::new('entrada') }
  $data = [Convert]::FromBase64String($parts[1])
  $entropy = [System.Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($parts[0] -eq 'protect') { $out = [System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope) }
  elseif ($parts[0] -eq 'unprotect') { $out = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope) }
  else { throw [System.ArgumentException]::new('modo') }
  [Array]::Clear($data, 0, $data.Length)
  [Console]::Out.Write([Convert]::ToBase64String($out))
  [Array]::Clear($out, 0, $out.Length)
  exit 0
} catch {
  [Console]::Error.Write($_.Exception.GetType().FullName)
  exit 1
}
`;

/** Argumentos de PowerShell: siempre los mismos, sin datos del usuario (el script va codificado). */
export function dpapiArgs(): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')];
}

/** DPAPI de Windows mediante PowerShell (`System.Security.Cryptography.ProtectedData`, CurrentUser). */
export function createDpapiCipher(opts: DpapiOptions = {}): Cipher {
  const powershell = opts.powershellPath ?? 'powershell.exe';
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const spawn: SpawnFn = opts.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, [...args], o));

  const run = (mode: 'protect' | 'unprotect', inputB64: string, sensitive: readonly string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(powershell, dpapiArgs(), { windowsHide: true, stdio: 'pipe', shell: false, env: childEnv() });
      } catch (err) {
        reject(new VaultError(`DPAPI (${mode}): no se pudo iniciar PowerShell: ${safe(err, sensitive)}`));
        return;
      }
      const out: Buffer[] = [];
      const errOut: Buffer[] = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new VaultError(`DPAPI (${mode}): PowerShell no respondió en ${timeoutMs} ms`)));
      }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => errOut.push(d));
      child.on('error', (err) => finish(() => reject(new VaultError(`DPAPI (${mode}): ${safe(err, sensitive)}`))));
      child.on('close', (code) => {
        if (code === 0) {
          const result = Buffer.concat(out).toString('ascii').trim();
          if (/^[A-Za-z0-9+/]+={0,2}$/.test(result)) return finish(() => resolve(result));
          return finish(() => reject(new VaultError(`DPAPI (${mode}): salida inesperada de PowerShell`)));
        }
        const kind = Buffer.concat(errOut).toString('utf8').trim().match(/^[\w.]{1,120}$/)?.[0] ?? 'error desconocido';
        finish(() => reject(new VaultError(`DPAPI (${mode}) falló con código ${code}: ${kind}`)));
      });
      child.stdin.on('error', () => { /* el proceso pudo cerrar stdin antes; lo informa 'close' */ });
      child.stdin.end(`${mode} ${inputB64}\n`);
    });

  return {
    async protect(plain) {
      const b64 = Buffer.from(plain, 'utf8').toString('base64');
      return run('protect', b64, [plain, b64]);
    },
    async unprotect(protectedB64) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(protectedB64)) throw new VaultError('DPAPI (unprotect): dato cifrado con formato inválido');
      const plainB64 = await run('unprotect', protectedB64, []);
      return Buffer.from(plainB64, 'base64').toString('utf8');
    },
  };
}

function safe(err: unknown, sensitive: readonly string[]): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(msg, sensitive).slice(0, 200);
}

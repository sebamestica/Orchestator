import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { taskBriefSchema, type TaskBrief } from '../../src/shared/tasks.ts';

const fixturesBaseUrl = new URL('../../fixtures/repo-ejemplo/', import.meta.url);
const plantillaDir = fileURLToPath(new URL('plantilla', fixturesBaseUrl));
const solucionesBaseDir = fileURLToPath(new URL('soluciones', fixturesBaseUrl));
const tareasJsonPath = new URL('tareas.json', fixturesBaseUrl);
const planPath = new URL('plan.md', fixturesBaseUrl);
const readmePath = new URL('README.md', fixturesBaseUrl);

function runGate(cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--test'], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function listFilesRelative(dir: string, baseDir = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await listFilesRelative(fullPath, baseDir);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      const rel = relative(baseDir, fullPath).replace(/\\/g, '/');
      files.push(rel);
    }
  }
  return files.sort();
}

describe('repo de ejemplo (F3: orquestación)', () => {
  it('tareas.json valida con taskBriefSchema, tiene IDs únicos y ownedPaths disjuntas', async () => {
    const raw = await readFile(tareasJsonPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    expect(Array.isArray(parsed)).toBe(true);
    const tareasRaw = parsed as unknown[];
    expect(tareasRaw).toHaveLength(3);

    const tareas: TaskBrief[] = tareasRaw.map((t) => taskBriefSchema.parse(t));

    // IDs únicos
    const ids = tareas.map((t) => t.id);
    const idSet = new Set(ids);
    expect(idSet.size).toBe(tareas.length);

    // Sin dependencias y dificultad baja
    for (const t of tareas) {
      expect(t.dependsOn).toEqual([]);
      expect(t.difficulty).toBe('low');
      expect(t.ownedPaths.length).toBeGreaterThan(0);
    }

    // ownedPaths no se solapan entre tareas
    const allPaths: string[] = [];
    for (const t of tareas) {
      for (const p of t.ownedPaths) {
        expect(allPaths).not.toContain(p);
        allPaths.push(p);
      }
    }
  });

  it('cada solución de referencia toca únicamente sus ownedPaths', async () => {
    const raw = await readFile(tareasJsonPath, 'utf8');
    const tareas: TaskBrief[] = (JSON.parse(raw) as unknown[]).map((t) => taskBriefSchema.parse(t));

    for (const task of tareas) {
      const solDir = join(solucionesBaseDir, task.id);
      const files = await listFilesRelative(solDir);

      expect(files.length).toBeGreaterThan(0);

      // Cada archivo en la solución debe estar en ownedPaths de esa tarea
      for (const file of files) {
        expect(task.ownedPaths).toContain(file);
      }

      // La solución debe cubrir todas las ownedPaths declaradas
      for (const owned of task.ownedPaths) {
        expect(files).toContain(owned);
      }
    }
  });

  it('la plantilla pasa el gate (node --test) tal como está', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'orq-plantilla-test-'));
    try {
      await cp(plantillaDir, tempDir, { recursive: true });
      const result = await runGate(tempDir);

      expect(result.code, `Gate falló en la plantilla:\n${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toMatch(/pass [1-9]\d*/);
      expect(result.stdout).toMatch(/fail 0/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('cada solución de referencia aplicada individualmente sobre la plantilla pasa el gate', async () => {
    const raw = await readFile(tareasJsonPath, 'utf8');
    const tareas: TaskBrief[] = (JSON.parse(raw) as unknown[]).map((t) => taskBriefSchema.parse(t));

    for (const task of tareas) {
      const tempDir = await mkdtemp(join(tmpdir(), `orq-solucion-${task.id}-`));
      try {
        await cp(plantillaDir, tempDir, { recursive: true });
        const solDir = join(solucionesBaseDir, task.id);
        await cp(solDir, tempDir, { recursive: true });

        const result = await runGate(tempDir);
        expect(result.code, `Gate falló para ${task.id}:\n${result.stderr}\n${result.stdout}`).toBe(0);
        expect(result.stdout).toMatch(/fail 0/);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('las 3 soluciones de referencia, aplicadas juntas, pasan el gate', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'orq-soluciones-test-'));
    try {
      await cp(plantillaDir, tempDir, { recursive: true });

      const raw = await readFile(tareasJsonPath, 'utf8');
      const tareas: TaskBrief[] = (JSON.parse(raw) as unknown[]).map((t) => taskBriefSchema.parse(t));

      for (const task of tareas) {
        const solDir = join(solucionesBaseDir, task.id);
        await cp(solDir, tempDir, { recursive: true });
      }

      const result = await runGate(tempDir);

      expect(result.code, `Gate falló al aplicar soluciones:\n${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toMatch(/fail 0/);
      expect(result.stdout).toMatch(/todo 0/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('incluye plan.md y README.md con documentación completa en español', async () => {
    const planContent = await readFile(planPath, 'utf8');
    expect(planContent.length).toBeGreaterThan(50);
    expect(planContent).toContain('text-utils');
    expect(planContent).toContain('task-slug');

    const readmeContent = await readFile(readmePath, 'utf8');
    expect(readmeContent.length).toBeGreaterThan(100);
    expect(readmeContent).toContain('plantilla');
    expect(readmeContent).toContain('git init');
  });
});

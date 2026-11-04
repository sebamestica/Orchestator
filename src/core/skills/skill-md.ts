import { z } from 'zod';
import { FrontmatterError, parseNote, type Frontmatter } from '../memory/frontmatter.ts';

/**
 * Lectura de `SKILL.md`: reutiliza el lector de frontmatter de la memoria (c4) en modo tolerante,
 * que acepta los 39 `SKILL.md` reales de este PC, y valida con Zod los campos de Agent Skills.
 */

/** Nombre de skill: minúsculas, dígitos y guiones simples (formato de Agent Skills), máx. 64. */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const skillNameSchema = z
  .string({ error: 'falta «name» o no es texto' })
  .max(64, '«name» supera 64 caracteres')
  .regex(SKILL_NAME_RE, '«name» debe usar minúsculas, dígitos y guiones');

export const skillFrontmatterSchema = z.looseObject({
  name: skillNameSchema,
  description: z.string({ error: 'falta «description» o no es texto' }).trim().min(1, '«description» está vacía').max(1024, '«description» supera 1024 caracteres'),
  license: z.string({ error: '«license» debe ser texto' }).optional(),
});

export interface SkillMeta {
  name: string;
  description: string;
  license?: string;
  frontmatter: Frontmatter;
}

export interface SkillMetaResult {
  /** Presente si el frontmatter es válido (aunque el nombre no coincida con la carpeta). */
  meta?: SkillMeta;
  /** Problemas que invalidan la skill. */
  problems: string[];
  /** Claves que el lector guardó como texto sin interpretar o descartó. */
  unsupported: string[];
}

/**
 * Lee y valida el frontmatter de un `SKILL.md`. Si se indica `folder`, exige que `name` coincida
 * con el nombre de la carpeta (como hacen Claude Code y Codex al cargar skills).
 */
export function readSkillMeta(text: string, folder?: string): SkillMetaResult {
  let parsed;
  try {
    parsed = parseNote(text, { lenient: true });
  } catch (err) {
    if (err instanceof FrontmatterError) return { problems: [`frontmatter no válido: ${err.message}`], unsupported: [] };
    throw err;
  }
  if (!parsed.hasFrontmatter) return { problems: ['SKILL.md no empieza con un bloque de frontmatter «---»'], unsupported: parsed.unsupported };
  const result = skillFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) return { problems: result.error.issues.map((i) => i.message), unsupported: parsed.unsupported };
  const { name, description, license } = result.data;
  const problems: string[] = [];
  if (folder !== undefined && folder !== name) problems.push(`«name» (${name}) no coincide con la carpeta (${folder})`);
  const meta: SkillMeta = { name, description, frontmatter: parsed.data };
  if (license !== undefined) meta.license = license;
  return { meta, problems, unsupported: parsed.unsupported };
}

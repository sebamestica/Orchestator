import { z } from 'zod';
import { skillNameSchema } from './skill-md.ts';

/** Marca de cuarentena: `AAAAMMDD-HHMMSS-xxxxxx` (UTC + 3 bytes aleatorios). */
export const STAMP_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
/** Id de cuarentena: `<nombre>-<marca>`; también es el nombre de la carpeta en `skills-entrantes`. */
export const QUARANTINE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{8}-\d{6}-[0-9a-f]{6}$/;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export const treeHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const skillSourceSchema = z.strictObject({
  kind: z.enum(['folder', 'zip']),
  /** Ruta de origen tal como se importó (pasada por `redactSecrets`). */
  path: z.string().min(1),
  /** SHA-256 del zip original. */
  sha256: sha256Hex.optional(),
  /** Carpeta de primer nivel del zip que contenía la skill, si la había. */
  topFolder: z.string().optional(),
});
export type SkillSource = z.infer<typeof skillSourceSchema>;

export const scriptReasonSchema = z.enum(['extensión', 'shebang', 'binario', 'manifiesto']);

export const fileInfoSchema = z.strictObject({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: sha256Hex,
  script: z.array(scriptReasonSchema).optional(),
});

export const licenseInfoSchema = z.strictObject({
  declared: z.string().optional(),
  files: z.array(z.string()),
  detected: z.string().optional(),
});

/** Informe de revisión de una skill en cuarentena (se guarda junto a ella como `<id>.revision.json`). */
export const skillReviewSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(QUARANTINE_ID_RE),
  name: skillNameSchema,
  description: z.string(),
  importedAt: z.iso.datetime(),
  source: skillSourceSchema,
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  treeHash: treeHashSchema,
  files: z.array(fileInfoSchema),
  /** Archivos que podrían ejecutarse, con el motivo. Nunca se ejecutan. */
  scripts: z.array(z.strictObject({ path: z.string(), reasons: z.array(scriptReasonSchema).min(1) })),
  license: licenseInfoSchema,
  /** Entradas omitidas al importar (p. ej. `.git`). */
  skipped: z.array(z.string()),
  warnings: z.array(z.string()),
  /** Comienzo de `SKILL.md` (pasado por `redactSecrets`) para mostrarlo en la revisión. */
  skillMdPreview: z.string(),
});
export type SkillReview = z.infer<typeof skillReviewSchema>;

export const lockEntrySchema = z.strictObject({
  name: skillNameSchema,
  description: z.string(),
  source: skillSourceSchema,
  treeHash: treeHashSchema,
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  scripts: z.array(z.string()),
  license: licenseInfoSchema,
  quarantineId: z.string().regex(QUARANTINE_ID_RE),
  importedAt: z.iso.datetime(),
  approvedAt: z.iso.datetime(),
});
export type LockEntry = z.infer<typeof lockEntrySchema>;

export const skillsLockSchema = z.strictObject({
  version: z.literal(1),
  updatedAt: z.iso.datetime(),
  skills: z.record(skillNameSchema, lockEntrySchema),
});
export type SkillsLock = z.infer<typeof skillsLockSchema>;

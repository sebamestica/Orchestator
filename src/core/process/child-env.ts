/**
 * Entorno para los procesos hijos del núcleo (CLIs de agentes, git, PowerShell). Parte del entorno del proceso,
 * pero **sin credenciales de proveedores de IA ni variables de una sesión anfitriona de Claude Code**. Así,
 * Codex, agy, git o PowerShell nunca heredan la clave de Claude del usuario, aunque el núcleo se haya lanzado
 * con ella en el entorno. Cada agente recibe solo sus propios secretos, explícitos, en `extra` (desde la bóveda).
 * Hallazgo de la revisión cruzada de Codex sobre `src/core/app` (2026-11-01).
 */
const STRIPPED = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENROUTER_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
  'ORQ_API_KEY',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_CLIENT_APP',
].map((name) => name.toUpperCase()));

/** True si la variable no debe pasar a un proceso hijo. En Windows los nombres no distinguen mayúsculas. */
export function isStrippedEnvName(name: string): boolean {
  return STRIPPED.has(name.toUpperCase());
}

export function childEnv(
  extra: Readonly<Record<string, string | undefined>> = {},
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !isStrippedEnvName(name)) env[name] = value;
  }
  // Lo explícito del llamador (secretos del propio agente desde la bóveda) sí pasa.
  for (const [name, value] of Object.entries(extra)) if (value !== undefined) env[name] = value;
  return env;
}

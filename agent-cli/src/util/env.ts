/** Prefer the Sublera spelling while retaining legacy deployment settings.
 * An explicitly supplied new value wins, even when empty or invalid. */
export function brandEnv(env: NodeJS.ProcessEnv, legacyKey: string): string | undefined {
  return env[legacyKey.replace(/^SUBLET_/, 'SUBLERA_')] ?? env[legacyKey];
}
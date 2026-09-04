import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The single-user deployment runs the same tenant-keyed code with exactly one
 * tenant. Every table, log line, and queue item carries this id.
 */
export const OWNER_TENANT_ID = 'owner';

export interface Tenant {
  id: string;
}

export function tenantDir(dataDir: string, tenantId: string): string {
  return join(dataDir, 'tenants', tenantId);
}

export function tenantAuthDir(dataDir: string, tenantId: string): string {
  return join(tenantDir(dataDir, tenantId), 'auth');
}

/**
 * One-time move of a pre-ADR-0001 `<dataDir>/auth/` into the owner tenant's
 * directory so an already-paired install keeps its session. Returns the
 * source and target when a move happened, otherwise undefined.
 */
export function migrateLegacyAuthDir(
  dataDir: string,
  tenantId: string,
): { from: string; to: string } | undefined {
  const from = join(dataDir, 'auth');
  const to = tenantAuthDir(dataDir, tenantId);
  if (!existsSync(from) || existsSync(to)) return undefined;
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return { from, to };
}

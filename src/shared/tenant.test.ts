import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateLegacyAuthDir, tenantAuthDir, tenantDir } from './tenant.js';

describe('tenant paths', () => {
  it('nest under data/tenants/<id>', () => {
    expect(tenantDir('/d', 'owner')).toBe('/d/tenants/owner');
    expect(tenantAuthDir('/d', 'acme')).toBe('/d/tenants/acme/auth');
  });
});

describe('migrateLegacyAuthDir', () => {
  it('moves data/auth into the tenant directory once', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wa-tenant-'));
    mkdirSync(join(dataDir, 'auth'));
    writeFileSync(join(dataDir, 'auth', 'creds.json'), '{}');

    const moved = migrateLegacyAuthDir(dataDir, 'owner');
    expect(moved).toEqual({ from: join(dataDir, 'auth'), to: join(dataDir, 'tenants/owner/auth') });
    expect(existsSync(join(dataDir, 'auth'))).toBe(false);
    expect(existsSync(join(dataDir, 'tenants/owner/auth/creds.json'))).toBe(true);

    expect(migrateLegacyAuthDir(dataDir, 'owner')).toBeUndefined();
  });

  it('does nothing when there is no legacy directory', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wa-tenant-'));
    expect(migrateLegacyAuthDir(dataDir, 'owner')).toBeUndefined();
    expect(existsSync(join(dataDir, 'tenants'))).toBe(false);
  });

  it('never overwrites an existing tenant auth directory', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wa-tenant-'));
    mkdirSync(join(dataDir, 'auth'));
    mkdirSync(join(dataDir, 'tenants/owner/auth'), { recursive: true });
    writeFileSync(join(dataDir, 'tenants/owner/auth/creds.json'), 'current');
    expect(migrateLegacyAuthDir(dataDir, 'owner')).toBeUndefined();
    expect(existsSync(join(dataDir, 'auth'))).toBe(true);
  });
});

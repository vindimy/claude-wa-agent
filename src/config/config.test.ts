import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './load.js';
import { allowedJids, configSchema, resolveGroupConfig } from './schema.js';

function writeTemp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wa-digest-config-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, content);
  return path;
}

describe('configSchema', () => {
  it('applies defaults to an empty config', () => {
    const config = configSchema.parse({});
    expect(config.defaults.summarizer).toBe('cli-claude');
    expect(config.defaults.cadence).toEqual({ type: 'daily', at: '08:00' });
    expect(config.defaults.deliver).toEqual({ self_dm: true, group: false, vault: true });
    expect(config.defaults.summary.max_words).toBe(300);
    expect(config.limits.max_sends_per_day).toBe(30);
    expect(config.ingest.media).toBe(false);
    expect(config.groups).toEqual([]);
  });

  it('rejects a group JID that is not a group', () => {
    const result = configSchema.safeParse({ groups: [{ jid: '15551234567@s.whatsapp.net' }] });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid cadence time', () => {
    const result = configSchema.safeParse({
      defaults: { cadence: { type: 'daily', at: '25:00' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a threshold cadence without messages', () => {
    const result = configSchema.safeParse({
      groups: [{ jid: '1@g.us', cadence: { type: 'threshold', max_hours: 24 } }],
    });
    expect(result.success).toBe(false);
  });
});

describe('resolveGroupConfig', () => {
  const config = configSchema.parse({
    defaults: { summary: { language: 'en', max_words: 200 } },
    groups: [
      { jid: '1@g.us', name: 'One', summary: { language: 'ru' } },
      { jid: '2@g.us', deliver: { group: true } },
    ],
  });

  it('merges group overrides over defaults', () => {
    const resolved = resolveGroupConfig(config, '1@g.us');
    expect(resolved?.summary.language).toBe('ru');
    expect(resolved?.summary.max_words).toBe(200);
    expect(resolved?.deliver.group).toBe(false);
  });

  it('keeps defaults where the group has no override', () => {
    const resolved = resolveGroupConfig(config, '2@g.us');
    expect(resolved?.deliver).toEqual({ self_dm: true, group: true, vault: true });
    expect(resolved?.summarizer).toBe('cli-claude');
  });

  it('returns undefined for a group not in config', () => {
    expect(resolveGroupConfig(config, 'nope@g.us')).toBeUndefined();
  });

  it('exposes the allow-list as a set', () => {
    expect(allowedJids(config)).toEqual(new Set(['1@g.us', '2@g.us']));
  });
});

describe('loadConfig', () => {
  it('loads and validates a YAML file', () => {
    const path = writeTemp('groups:\n  - jid: "1@g.us"\n    name: Test\n');
    const result = loadConfig(path);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.groups[0]?.name).toBe('Test');
  });

  it('returns a read error for a missing file', () => {
    const result = loadConfig('/nonexistent/config.yaml');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('read');
  });

  it('returns a parse error for broken YAML', () => {
    const path = writeTemp('groups: [unclosed');
    const result = loadConfig(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('parse');
  });

  it('returns a validate error for a bad schema', () => {
    const path = writeTemp('groups:\n  - name: no jid\n');
    const result = loadConfig(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe('validate');
  });
});

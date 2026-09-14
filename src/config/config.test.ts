import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyDashboardEnv, loadConfig, overrideSummarizer } from './load.js';
import {
  allowedJids,
  configSchema,
  enrichSummarizer,
  findRecapConfig,
  isDestinationAllowed,
  resolveGroupConfig,
  resolveRecapConfig,
  resolveScopeDestinations,
} from './schema.js';

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
    expect(config.defaults.deliver).toEqual({ self_dm: true, group: false, vault: true, to: [] });
    expect(config.defaults.summary).toEqual({
      language: 'en',
      style: 'topics',
      max_words: 300,
      personality: 'neutral',
      instructions: '',
    });
    expect(config.limits.max_sends_per_day).toBe(30);
    expect(config.limits.min_group_post_gap_minutes).toBe(60);
    expect(config.retention.days).toBe(30);
    expect(config.ingest.media).toBe(false);
    expect(config.groups).toEqual([]);
  });

  it('accepts only the supported retention periods', () => {
    expect(configSchema.parse({ retention: { days: 90 } }).retention.days).toBe(90);
    expect(configSchema.safeParse({ retention: { days: 45 } }).success).toBe(false);
    expect(configSchema.safeParse({ retention: { days: 0 } }).success).toBe(false);
  });

  it('refuses to enable group posting globally', () => {
    const result = configSchema.safeParse({ defaults: { deliver: { group: true } } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('per group');
    expect(
      configSchema.safeParse({ groups: [{ jid: '1@g.us', deliver: { group: true } }] }).success,
    ).toBe(true);
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

  it.each(['auto', 'ru', 'en', 'pt', 'es', 'zh', 'ja'])(
    'accepts summary language %s',
    (language) => {
      const result = configSchema.safeParse({ defaults: { summary: { language } } });
      expect(result.success).toBe(true);
    },
  );

  it('rejects an unknown summary language', () => {
    const result = configSchema.safeParse({ defaults: { summary: { language: 'xx' } } });
    expect(result.success).toBe(false);
  });

  it('rejects a threshold cadence without messages', () => {
    const result = configSchema.safeParse({
      groups: [{ jid: '1@g.us', cadence: { type: 'threshold', max_hours: 24 } }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts destinations and per-group deliver.to', () => {
    const config = configSchema.parse({
      destinations: { hub: { group: '9@g.us' }, me: { number: '+13105551234' } },
      groups: [{ jid: '1@g.us', deliver: { to: ['hub', 'me'] } }],
    });
    expect(config.defaults.deliver.to).toEqual([]);
    expect(resolveGroupConfig(config, '1@g.us')?.deliver.to).toEqual(['hub', 'me']);
  });

  it('refuses a global deliver.to', () => {
    const result = configSchema.safeParse({
      destinations: { hub: { group: '9@g.us' } },
      defaults: { deliver: { to: ['hub'] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('per group');
  });

  it('rejects an unknown destination name on a group', () => {
    const result = configSchema.safeParse({
      destinations: { hub: { group: '9@g.us' } },
      groups: [{ jid: '1@g.us', deliver: { to: ['hubb'] } }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('unknown destination "hubb"');
      expect(result.error.issues[0]?.path).toEqual(['groups', 0, 'deliver', 'to', 0]);
    }
  });
});

describe('resolveScopeDestinations', () => {
  it('resolves a group scope to its destinations in config order', () => {
    const config = configSchema.parse({
      destinations: { hub: { group: '9@g.us' }, me: { number: '+13105551234' } },
      groups: [{ jid: '1@g.us', deliver: { to: ['me', 'hub'] } }, { jid: '2@g.us' }],
    });
    expect(resolveScopeDestinations(config, '1@g.us')).toEqual([
      { name: 'me', kind: 'number', jid: '13105551234@s.whatsapp.net' },
      { name: 'hub', kind: 'group', jid: '9@g.us' },
    ]);
    expect(resolveScopeDestinations(config, '2@g.us')).toEqual([]);
    expect(resolveScopeDestinations(config, 'unknown@g.us')).toEqual([]);
  });
});

describe('isDestinationAllowed', () => {
  const HUB = '9@g.us';
  const ME = '13105551234@s.whatsapp.net';
  const raw = {
    defaults: { summarizer: 'fake' },
    destinations: { hub: { group: HUB }, me: { number: '+13105551234' } },
    groups: [{ jid: '1@g.us', name: 'Team', deliver: { to: ['hub', 'me'] } }],
    recaps: [{ name: 'Weekly', sources: ['Team'], deliver: { to: ['hub'] } }],
  };
  const config = configSchema.parse(raw);

  it('allows a destination a group scope still lists', () => {
    expect(isDestinationAllowed(config, '1@g.us', 'hub', HUB)).toBe(true);
    expect(isDestinationAllowed(config, '1@g.us', 'me', ME)).toBe(true);
  });

  it('allows a destination a recap scope still lists', () => {
    expect(isDestinationAllowed(config, 'recap:Weekly', 'hub', HUB)).toBe(true);
  });

  it('denies a destination deleted from config', () => {
    const edited = configSchema.parse({
      ...raw,
      destinations: { me: { number: '+13105551234' } },
      groups: [{ jid: '1@g.us', name: 'Team', deliver: { to: ['me'] } }],
      recaps: [{ name: 'Weekly', sources: ['Team'] }],
    });
    expect(isDestinationAllowed(edited, '1@g.us', 'hub', HUB)).toBe(false);
    expect(isDestinationAllowed(edited, 'recap:Weekly', 'hub', HUB)).toBe(false);
  });

  it('denies a destination retargeted to another JID', () => {
    const edited = configSchema.parse({
      ...raw,
      destinations: { hub: { group: '8@g.us' }, me: { number: '+13105551234' } },
    });
    expect(isDestinationAllowed(edited, '1@g.us', 'hub', HUB)).toBe(false);
    expect(isDestinationAllowed(edited, '1@g.us', 'hub', '8@g.us')).toBe(true);
  });

  it('denies a destination the scope no longer lists', () => {
    const edited = configSchema.parse({
      ...raw,
      groups: [{ jid: '1@g.us', name: 'Team', deliver: { to: ['me'] } }],
      recaps: [{ name: 'Weekly', sources: ['Team'] }],
    });
    expect(isDestinationAllowed(edited, '1@g.us', 'hub', HUB)).toBe(false);
    expect(isDestinationAllowed(edited, 'recap:Weekly', 'hub', HUB)).toBe(false);
    expect(isDestinationAllowed(edited, '1@g.us', 'me', ME)).toBe(true);
  });

  it('denies an unknown scope key', () => {
    expect(isDestinationAllowed(config, '2@g.us', 'hub', HUB)).toBe(false);
    expect(isDestinationAllowed(config, 'recap:Nope', 'hub', HUB)).toBe(false);
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
    expect(resolved?.deliver).toEqual({ self_dm: true, group: true, vault: true, to: [] });
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

describe('summarizers section', () => {
  it('defaults to an empty map and validates per-adapter options', () => {
    const empty = configSchema.parse({});
    expect(empty.summarizers).toEqual({});
    expect(empty.vault.dir).toBe('./vault');
    expect(configSchema.parse({ vault: { dir: '/notes' } }).vault.dir).toBe('/notes');
    const parsed = configSchema.parse({
      summarizers: { 'cli-claude': { model: 'sonnet', timeout_seconds: 120 } },
    });
    expect(parsed.summarizers['cli-claude']?.model).toBe('sonnet');
    expect(() =>
      configSchema.parse({ summarizers: { 'cli-claude': { timeout_seconds: -1 } } }),
    ).toThrow();
  });
});

describe('overrideSummarizer', () => {
  it('forces one adapter on defaults and every group', () => {
    const config = configSchema.parse({
      defaults: { summarizer: 'cli-claude' },
      groups: [{ jid: '1@g.us', summarizer: 'fake' }, { jid: '2@g.us' }],
    });
    const forced = overrideSummarizer(config, 'api-anthropic');
    expect(forced.defaults.summarizer).toBe('api-anthropic');
    expect(resolveGroupConfig(forced, '1@g.us')?.summarizer).toBe('api-anthropic');
    expect(resolveGroupConfig(forced, '2@g.us')?.summarizer).toBe('api-anthropic');
    // the original is untouched
    expect(resolveGroupConfig(config, '1@g.us')?.summarizer).toBe('fake');
  });
});

describe('dashboard section', () => {
  it('is off by default and bound to loopback', () => {
    const config = configSchema.parse({});
    expect(config.dashboard).toEqual({ enabled: false, host: '127.0.0.1', port: 8787 });
  });

  it('validates the port and accepts a custom bind address', () => {
    const config = configSchema.parse({
      dashboard: { enabled: true, host: '0.0.0.0', port: 9000 },
    });
    expect(config.dashboard).toEqual({ enabled: true, host: '0.0.0.0', port: 9000 });
    expect(configSchema.safeParse({ dashboard: { port: 0 } }).success).toBe(false);
    expect(configSchema.safeParse({ dashboard: { port: 70000 } }).success).toBe(false);
  });

  it('lets DASHBOARD_PORT and DASHBOARD_HOST override and enable it', () => {
    const base = configSchema.parse({});
    expect(applyDashboardEnv(base, {}).dashboard).toEqual(base.dashboard);
    expect(applyDashboardEnv(base, { DASHBOARD_PORT: '9100' }).dashboard).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 9100,
    });
    expect(applyDashboardEnv(base, { DASHBOARD_HOST: '0.0.0.0' }).dashboard).toEqual({
      enabled: false,
      host: '0.0.0.0',
      port: 8787,
    });
    expect(applyDashboardEnv(base, { DASHBOARD_PORT: 'abc' }).dashboard).toEqual(base.dashboard);
  });
});

describe('ingest and enrich sections', () => {
  it('describes nothing by default and caps model calls', () => {
    const config = configSchema.parse({});
    expect(config.ingest).toEqual({ media: false, describe_images: false, describe_links: false });
    expect(config.enrich).toEqual({ summarizer: undefined, max_per_day: 200 });
  });

  it('merges a sparse per-group ingest override over the global block', () => {
    const config = configSchema.parse({
      ingest: { describe_links: true },
      groups: [{ jid: '1@g.us', ingest: { describe_images: true } }, { jid: '2@g.us' }],
    });
    expect(resolveGroupConfig(config, '1@g.us')?.ingest).toEqual({
      media: false,
      describe_images: true,
      describe_links: true,
    });
    expect(resolveGroupConfig(config, '2@g.us')?.ingest).toEqual({
      media: false,
      describe_images: false,
      describe_links: true,
    });
  });

  it('uses defaults.summarizer for descriptions unless enrich.summarizer is set', () => {
    const plain = configSchema.parse({ defaults: { summarizer: 'fake' } });
    expect(enrichSummarizer(plain)).toBe('fake');
    const pinned = configSchema.parse({
      defaults: { summarizer: 'fake' },
      enrich: { summarizer: 'api-google', max_per_day: 10 },
    });
    expect(enrichSummarizer(pinned)).toBe('api-google');
    expect(pinned.enrich.max_per_day).toBe(10);
  });

  it('SUMMARIZER override also applies to descriptions', () => {
    const config = configSchema.parse({ enrich: { summarizer: 'cli-codex' } });
    expect(enrichSummarizer(overrideSummarizer(config, 'api-anthropic'))).toBe('api-anthropic');
  });
});

describe('recaps', () => {
  const base = {
    defaults: { summarizer: 'fake', cadence: { type: 'daily', at: '08:00' } },
    destinations: { hub: { group: '9@g.us' }, me: { number: '+13105551234' } },
    groups: [
      { jid: '1@g.us', name: 'Announcements' },
      { jid: '2@g.us', name: 'Nerds', summarizer: 'cli-gemini' },
    ],
  };

  it('resolves a recap with defaults applied', () => {
    const config = configSchema.parse({
      ...base,
      recaps: [
        {
          name: 'SoCal Zouk',
          sources: ['announcements', '2@g.us'],
          cadence: { type: 'weekly', day: 'sun', at: '18:00' },
          summary: { max_words: 600, instructions: 'Lead with events.' },
          deliver: { to: ['hub', 'me'] },
        },
      ],
    });
    const recap = resolveRecapConfig(config, 'socal zouk');
    expect(recap).toEqual({
      name: 'SoCal Zouk',
      key: 'recap:SoCal Zouk',
      sources: [
        { jid: '1@g.us', name: 'Announcements' },
        { jid: '2@g.us', name: 'Nerds' },
      ],
      summarizer: 'fake',
      cadence: { type: 'weekly', day: 'sun', at: '18:00' },
      deliver: { self_dm: true, vault: true, to: ['hub', 'me'] },
      summary: {
        language: 'en',
        style: 'topics',
        max_words: 600,
        personality: 'neutral',
        instructions: 'Lead with events.',
      },
    });
    expect(resolveScopeDestinations(config, 'recap:SoCal Zouk')).toEqual([
      { name: 'hub', kind: 'group', jid: '9@g.us' },
      { name: 'me', kind: 'number', jid: '13105551234@s.whatsapp.net' },
    ]);
  });

  it('finds a recap by substring after an exact match', () => {
    const config = configSchema.parse({
      ...base,
      recaps: [
        { name: 'Zouk', sources: ['Nerds'] },
        { name: 'Zouk Weekly', sources: ['Nerds'] },
      ],
    });
    expect(findRecapConfig(config, 'zouk')?.name).toBe('Zouk');
    expect(findRecapConfig(config, 'weekly')?.name).toBe('Zouk Weekly');
    expect(findRecapConfig(config, 'nothing')).toBeUndefined();
  });

  it('rejects a recap whose source is not a configured group', () => {
    const result = configSchema.safeParse({
      ...base,
      recaps: [{ name: 'R', sources: ['Announcements', 'Family'] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('unknown source "Family"');
      expect(result.error.issues[0]?.path).toEqual(['recaps', 0, 'sources', 1]);
    }
  });

  it('rejects a repeated source', () => {
    const result = configSchema.safeParse({
      ...base,
      recaps: [{ name: 'R', sources: ['Announcements', '1@g.us'] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('repeated');
  });

  it('rejects a recap name that collides with a group or another recap', () => {
    const dup = configSchema.safeParse({
      ...base,
      recaps: [
        { name: 'R', sources: ['Nerds'] },
        { name: 'r', sources: ['Nerds'] },
      ],
    });
    expect(dup.success).toBe(false);
    const group = configSchema.safeParse({
      ...base,
      recaps: [{ name: 'nerds', sources: ['Nerds'] }],
    });
    expect(group.success).toBe(false);
    if (!group.success) expect(group.error.issues[0]?.message).toContain('same name as a group');
  });

  it('rejects an unknown destination or a group key on a recap', () => {
    const unknown = configSchema.safeParse({
      ...base,
      recaps: [{ name: 'R', sources: ['Nerds'], deliver: { to: ['nope'] } }],
    });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.issues[0]?.path).toEqual(['recaps', 0, 'deliver', 'to', 0]);
    }
    const withGroup = configSchema.safeParse({
      ...base,
      recaps: [{ name: 'R', sources: ['Nerds'], deliver: { group: true } }],
    });
    expect(withGroup.success).toBe(false);
  });

  it('checks recap personalities like group ones', () => {
    const result = configSchema.safeParse({
      ...base,
      recaps: [{ name: 'R', sources: ['Nerds'], summary: { personality: 'nope' } }],
    });
    expect(result.success).toBe(false);
  });
});

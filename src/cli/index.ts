import { join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  allowedJids,
  type Config,
  type ConfigError,
  loadConfig,
  type ResolvedGroupConfig,
  resolveGroupConfig,
} from '../config/index.js';
import { startListener } from '../listener/index.js';
import { createLogger, migrateLegacyAuthDir, OWNER_TENANT_ID } from '../shared/index.js';
import { Store } from '../store/index.js';
import { ADAPTER_NAMES, createSummarizer, type SummarizerError } from '../summarizer/index.js';
import { parseSince } from './since.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file — fine, env vars may be set another way
}

const log = createLogger('cli');

const configPath = resolve(process.env.CONFIG_PATH ?? './config.yaml');
const dataDir = resolve(process.env.DATA_DIR ?? './data');
const dbPath = join(dataDir, 'digest.db');
// The single-user deployment is tenant "owner"; everything is keyed by it.
const tenantId = OWNER_TENANT_ID;

function loadConfigOrExit() {
  const result = loadConfig(configPath);
  if (!result.ok) {
    log.error({ error: result.error }, formatConfigError(result.error));
    process.exit(1);
  }
  return result.value;
}

function formatConfigError(e: ConfigError): string {
  switch (e.tag) {
    case 'read':
      return `cannot read config at ${e.path} — copy config.example.yaml to config.yaml`;
    case 'parse':
      return `config at ${e.path} is not valid YAML: ${e.message}`;
    case 'validate':
      return `config at ${e.path} is invalid:\n${e.message}`;
  }
}

const program = new Command();
program.name('digest').description('WhatsApp group digest agent');

program
  .command('run')
  .description('start the listener (pairs via QR code on first run)')
  .action(async () => {
    const config = loadConfigOrExit();
    const moved = migrateLegacyAuthDir(dataDir, tenantId);
    if (moved) log.warn(moved, 'moved legacy auth state into the tenant directory');
    const store = new Store(dbPath);
    log.info(
      { tenant_id: tenantId, configPath, dataDir, allowedGroups: config.groups.length },
      'starting listener',
    );
    const listener = await startListener({ tenantId, config, store, dataDir });

    const shutdown = async (signal: string) => {
      log.info({ signal }, 'shutting down');
      await listener.stop();
      store.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  });

program
  .command('groups')
  .description('list groups seen by the listener and their allow-list status')
  .action(() => {
    const config = loadConfigOrExit();
    const allowed = allowedJids(config);
    const store = new Store(dbPath);
    const rows = store.listGroups(tenantId);
    store.close();

    if (rows.length === 0 && allowed.size === 0) {
      console.log('No groups configured or seen yet. Run `digest run` and let it connect first.');
      return;
    }

    const seen = new Set(rows.map((r) => r.jid));
    for (const row of rows) {
      const mark = allowed.has(row.jid) ? '✓' : ' ';
      const last = row.lastMessageTs
        ? new Date(row.lastMessageTs * 1000).toISOString().slice(0, 16).replace('T', ' ')
        : '—';
      console.log(
        `[${mark}] ${row.jid}  ${row.subject ?? '(no subject)'}  messages: ${row.messageCount}  last: ${last}`,
      );
    }
    for (const jid of allowed) {
      if (!seen.has(jid)) {
        console.log(`[✓] ${jid}  (configured, not seen yet)`);
      }
    }
    console.log('\n[✓] = allow-listed in config.yaml; only these groups are ingested.');
  });

/**
 * Resolve `<group>` as a JID, a configured `name` (case-insensitive), or a
 * group subject the listener has seen. Only allow-listed groups resolve.
 */
function findGroup(config: Config, store: Store, ref: string): ResolvedGroupConfig | undefined {
  const needle = ref.trim().toLowerCase();
  const byJid = resolveGroupConfig(config, ref.trim());
  if (byJid) return byJid;
  const byName = config.groups.find((g) => g.name?.toLowerCase() === needle);
  if (byName) return resolveGroupConfig(config, byName.jid);
  const bySubject = store.listGroups(tenantId).filter((g) => g.subject?.toLowerCase() === needle);
  const first = bySubject[0];
  if (bySubject.length === 1 && first) return resolveGroupConfig(config, first.jid);
  return undefined;
}

function formatSummarizerError(e: SummarizerError): string {
  switch (e.tag) {
    case 'empty':
      return 'no messages to summarize';
    case 'spawn':
      return `cannot start ${e.bin}: ${e.message}`;
    case 'timeout':
      return `${e.bin} did not finish within ${Math.round(e.timeoutMs / 1000)}s`;
    case 'exit':
      return `${e.bin} exited with code ${e.code}: ${e.stderr.trim() || '(no stderr)'}`;
    case 'parse':
      return `could not parse adapter output: ${e.message}`;
    case 'model':
      return `adapter error: ${e.message}`;
  }
}

program
  .command('summarize')
  .description('summarize one group over a time window (phase 2: --dry-run only)')
  .argument('<group>', 'group JID, configured name, or subject')
  .requiredOption('--since <window>', 'relative span (30m, 12h, 2d, 1w) or ISO date')
  .option('--dry-run', 'print the summary instead of delivering it')
  .option('--adapter <name>', `summarizer adapter (${ADAPTER_NAMES.join(', ')})`)
  .option('--style <style>', 'topics | narrative | action-items')
  .option('--language <lang>', 'auto | ru | en')
  .option('--max-words <n>', 'length cap', (v: string) => Number.parseInt(v, 10))
  .option('--tz <zone>', 'IANA time zone for transcript timestamps')
  .action(
    async (
      groupRef: string,
      opts: {
        since: string;
        dryRun?: boolean;
        adapter?: string;
        style?: string;
        language?: string;
        maxWords?: number;
        tz?: string;
      },
    ) => {
      if (!opts.dryRun) {
        console.error('Delivery is not implemented yet (phase 3). Re-run with --dry-run.');
        process.exit(2);
      }
      const config = loadConfigOrExit();
      const store = new Store(dbPath);
      try {
        const group = findGroup(config, store, groupRef);
        if (!group) {
          const known = config.groups.map((g) => `  ${g.jid}  ${g.name ?? ''}`).join('\n');
          console.error(
            `Unknown or non-allow-listed group "${groupRef}". Configured groups:\n${known}`,
          );
          process.exit(1);
        }

        const nowTs = Math.floor(Date.now() / 1000);
        const since = parseSince(opts.since, nowTs);
        if (!since.ok) {
          console.error(`Bad --since "${opts.since}": use 30m, 12h, 2d, 1w or an ISO date.`);
          process.exit(1);
        }

        const messages = store.messagesSince(tenantId, group.jid, since.value);
        if (messages.length === 0) {
          console.log(`No messages in ${group.name ?? group.jid} since ${opts.since}.`);
          return;
        }

        const adapterName = opts.adapter ?? group.summarizer;
        const adapterCfg = config.summarizers[adapterName] ?? {};
        const summarizer = createSummarizer(adapterName, {
          bin: adapterCfg.bin,
          model: adapterCfg.model,
          timeoutMs: adapterCfg.timeout_seconds ? adapterCfg.timeout_seconds * 1000 : undefined,
        });
        if (!summarizer.ok) {
          console.error(
            `Unknown summarizer "${adapterName}". Available: ${summarizer.error.available.join(', ')}`,
          );
          process.exit(1);
        }

        const summaryOptions = { ...group.summary };
        if (opts.style) summaryOptions.style = opts.style as typeof summaryOptions.style;
        if (opts.language)
          summaryOptions.language = opts.language as typeof summaryOptions.language;
        if (opts.maxWords && opts.maxWords > 0) summaryOptions.max_words = opts.maxWords;

        const cadenceTz = 'tz' in group.cadence ? group.cadence.tz : undefined;
        const tz = opts.tz ?? cadenceTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

        log.info(
          {
            tenant_id: tenantId,
            group: group.jid,
            adapter: adapterName,
            messages: messages.length,
            since: opts.since,
          },
          'summarizing (dry run)',
        );
        const result = await summarizer.value.summarize({
          tenantId,
          groupJid: group.jid,
          groupName: group.name ?? group.jid,
          messages,
          sinceTs: since.value,
          untilTs: nowTs,
          tz,
          options: summaryOptions,
        });
        if (!result.ok) {
          log.error({ error: result.error }, formatSummarizerError(result.error));
          process.exit(1);
        }

        const s = result.value;
        console.log(`\n${s.text}\n`);
        log.info(
          {
            adapter: s.adapter,
            model: s.model,
            messages: s.messageCount,
            inputChars: s.inputChars,
            words: s.text.split(/\s+/).length,
            durationMs: s.durationMs,
            costUsd: s.costUsd,
          },
          'dry run complete — nothing was delivered',
        );
      } finally {
        store.close();
      }
    },
  );

program.parseAsync().catch((e: unknown) => {
  log.error({ err: e }, 'fatal error');
  process.exit(1);
});

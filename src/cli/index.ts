import { join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  allowedJids,
  type Config,
  type ConfigError,
  loadConfig,
  type ResolvedGroupConfig,
  resolveGroupConfig,
  type SummaryOptions,
} from '../config/index.js';
import { type DeliveryOutcome, startOutbox } from '../delivery/index.js';
import { startListener } from '../listener/index.js';
import {
  describeDigestError,
  runDigest,
  startScheduler,
  systemTimeZone,
} from '../scheduler/index.js';
import { createLogger, migrateLegacyAuthDir, OWNER_TENANT_ID } from '../shared/index.js';
import { Store } from '../store/index.js';
import { ADAPTER_NAMES } from '../summarizer/index.js';
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
    const vaultDir = resolve(process.env.VAULT_DIR ?? config.vault.dir);
    const scheduler = startScheduler({ tenantId, config, store, vaultDir });
    const listener = await startListener({
      tenantId,
      config,
      store,
      dataDir,
      onCommand: (cmd) => void scheduler.handleCommand(cmd.text),
    });
    const outbox = startOutbox({
      tenantId,
      store,
      transport: listener,
      maxSendsPerDay: config.limits.max_sends_per_day,
    });

    const shutdown = async (signal: string) => {
      log.info({ signal }, 'shutting down');
      scheduler.stop();
      outbox.stop();
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

function formatOutcome(o: DeliveryOutcome): string {
  switch (o.channel) {
    case 'vault':
      if (o.outcome === 'written') return `vault:    wrote ${o.path}`;
      if (o.outcome === 'already')
        return `vault:    already written${o.path ? ` (${o.path})` : ''}`;
      return `vault:    FAILED — ${o.message}`;
    case 'self_dm':
      if (o.outcome === 'queued') return 'self-DM:  queued — the listener (`digest run`) sends it';
      return o.status === 'sent' ? 'self-DM:  already sent' : 'self-DM:  already queued';
    case 'group':
      return `group:    skipped — ${o.reason}`;
  }
}

program
  .command('summarize')
  .description('summarize one group over a time window and deliver it (or --dry-run)')
  .argument('<group>', 'group JID, configured name, or subject')
  .requiredOption('--since <window>', 'relative span (30m, 12h, 2d, 1w) or ISO date')
  .option('--dry-run', 'print the summary instead of delivering it')
  .option('--fresh', 'regenerate even if this exact window was summarized before')
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
        fresh?: boolean;
        adapter?: string;
        style?: string;
        language?: string;
        maxWords?: number;
        tz?: string;
      },
    ) => {
      const config = loadConfigOrExit();
      const vaultDir = resolve(process.env.VAULT_DIR ?? config.vault.dir);
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

        const summaryOptions: Partial<SummaryOptions> = {};
        if (opts.style) summaryOptions.style = opts.style as SummaryOptions['style'];
        if (opts.language) summaryOptions.language = opts.language as SummaryOptions['language'];
        if (opts.maxWords && opts.maxWords > 0) summaryOptions.max_words = opts.maxWords;
        const cadenceTz = 'tz' in group.cadence ? group.cadence.tz : undefined;
        const tz = opts.tz ?? cadenceTz ?? systemTimeZone();

        const result = await runDigest({
          tenantId,
          store,
          config,
          group,
          sinceTs: since.value,
          untilTs: nowTs,
          trigger: 'manual',
          tz,
          vaultDir,
          dryRun: opts.dryRun,
          fresh: opts.fresh,
          adapter: opts.adapter,
          summaryOptions,
        });
        if (!result.ok) {
          log.error({ error: result.error }, describeDigestError(result.error));
          process.exit(1);
        }
        if (result.value.kind === 'empty') {
          console.log(`No messages in ${group.name ?? group.jid} since ${opts.since}.`);
          return;
        }
        const { summary, reused, outcomes } = result.value;
        if (reused)
          console.log('(reusing the stored summary for these messages; --fresh regenerates)');
        console.log(`\n${summary.text}\n`);
        if (opts.dryRun) {
          console.log('(dry run — nothing delivered; the summary is stored and will be reused)');
          return;
        }
        for (const o of outcomes) console.log(formatOutcome(o));
        if (outcomes.some((o) => o.outcome === 'error')) process.exit(1);
      } finally {
        store.close();
      }
    },
  );

program
  .command('schedule')
  .description('show each group’s cadence, last run, and whether a digest is due now')
  .action(() => {
    const config = loadConfigOrExit();
    const store = new Store(dbPath);
    const scheduler = startScheduler({
      tenantId,
      config,
      store,
      vaultDir: resolve(process.env.VAULT_DIR ?? config.vault.dir),
      tickMs: 3_600_000,
    });
    try {
      for (const { group, state, decision } of scheduler.describe()) {
        const cadence = describeCadence(group.cadence);
        const last = state.runs[0];
        const lastStr = last ? `${fmtTs(last.createdTs)} ${last.trigger}/${last.status}` : 'never';
        const wm = state.watermark ? fmtTs(state.watermark.watermarkTs) : '—';
        const due = decision.due ? `DUE (${decision.reason})` : `not due: ${decision.reason}`;
        console.log(`${group.name ?? group.jid}`);
        console.log(`  cadence:   ${cadence}`);
        console.log(`  last run:  ${lastStr}`);
        console.log(`  watermark: ${wm}`);
        if (group.cadence.type === 'threshold')
          console.log(`  pending:   ${state.pendingMessages} messages`);
        console.log(`  status:    ${due}`);
      }
    } finally {
      scheduler.stop();
      store.close();
    }
  });

function describeCadence(c: ResolvedGroupConfig['cadence']): string {
  switch (c.type) {
    case 'daily':
      return `daily at ${c.at}${c.tz ? ` ${c.tz}` : ''}`;
    case 'weekly':
      return `weekly on ${c.day} at ${c.at}${c.tz ? ` ${c.tz}` : ''}`;
    case 'threshold':
      return `every ${c.messages} messages or ${c.max_hours}h`;
    case 'manual':
      return 'manual only';
  }
}

function fmtTs(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

program.parseAsync().catch((e: unknown) => {
  log.error({ err: e }, 'fatal error');
  process.exit(1);
});

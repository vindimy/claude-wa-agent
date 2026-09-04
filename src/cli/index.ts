import { randomUUID } from 'node:crypto';
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
import { type DeliveryOutcome, deliverSummary, startOutbox } from '../delivery/index.js';
import { startListener } from '../listener/index.js';
import { createLogger, migrateLegacyAuthDir, OWNER_TENANT_ID } from '../shared/index.js';
import { Store, type SummaryRecord, summaryId } from '../store/index.js';
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
    const outbox = startOutbox({
      tenantId,
      store,
      transport: listener,
      maxSendsPerDay: config.limits.max_sends_per_day,
    });

    const shutdown = async (signal: string) => {
      log.info({ signal }, 'shutting down');
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

        // Identity = the message set, so a drifting relative --since still
        // maps to the same summary while the same messages fall inside it.
        const first = messages[0];
        const last = messages[messages.length - 1];
        if (!first || !last) return;
        const sid = summaryId({
          tenantId,
          groupJid: group.jid,
          firstTs: first.ts,
          firstId: first.id,
          lastTs: last.ts,
          lastId: last.id,
        });
        const groupName = group.name ?? group.jid;
        const mode = opts.dryRun ? 'dry run' : 'deliver';

        let summary = opts.fresh ? undefined : store.getSummary(tenantId, sid);
        if (summary) {
          log.info(
            { tenant_id: tenantId, group: group.jid, summaryId: sid, mode },
            'reusing stored summary for this window (pass --fresh to regenerate)',
          );
        } else {
          log.info(
            {
              tenant_id: tenantId,
              group: group.jid,
              adapter: adapterName,
              messages: messages.length,
              since: opts.since,
              mode,
            },
            'summarizing',
          );
          const result = await summarizer.value.summarize({
            tenantId,
            groupJid: group.jid,
            groupName,
            messages,
            sinceTs: since.value,
            untilTs: nowTs,
            tz,
            options: summaryOptions,
          });
          const createdTs = Math.floor(Date.now() / 1000);
          if (!result.ok) {
            store.insertRun({
              tenantId,
              id: randomUUID(),
              groupJid: group.jid,
              trigger: 'manual',
              dryRun: Boolean(opts.dryRun),
              sinceTs: since.value,
              untilTs: nowTs,
              messageCount: messages.length,
              watermarkTs: last.ts,
              watermarkId: last.id,
              summaryId: null,
              adapter: adapterName,
              model: null,
              status: 'error',
              error: formatSummarizerError(result.error),
              costUsd: null,
              durationMs: null,
              createdTs,
            });
            log.error({ error: result.error }, formatSummarizerError(result.error));
            process.exit(1);
          }
          const s = result.value;
          summary = {
            tenantId,
            id: sid,
            groupJid: group.jid,
            sinceTs: since.value,
            untilTs: nowTs,
            watermarkTs: last.ts,
            watermarkId: last.id,
            messageCount: messages.length,
            adapter: s.adapter,
            model: s.model,
            text: s.text,
            createdTs,
          } satisfies SummaryRecord;
          store.upsertSummary(summary);
          store.insertRun({
            tenantId,
            id: randomUUID(),
            groupJid: group.jid,
            trigger: 'manual',
            dryRun: Boolean(opts.dryRun),
            sinceTs: since.value,
            untilTs: nowTs,
            messageCount: messages.length,
            watermarkTs: last.ts,
            watermarkId: last.id,
            summaryId: sid,
            adapter: s.adapter,
            model: s.model,
            status: 'ok',
            error: null,
            costUsd: s.costUsd,
            durationMs: s.durationMs,
            createdTs,
          });
          log.info(
            {
              adapter: s.adapter,
              model: s.model,
              messages: s.messageCount,
              inputChars: s.inputChars,
              words: s.text.split(/\s+/).length,
              durationMs: s.durationMs,
              costUsd: s.costUsd,
              summaryId: sid,
            },
            'summary generated and recorded',
          );
        }

        console.log(`\n${summary.text}\n`);

        if (opts.dryRun) {
          console.log('(dry run — nothing delivered; the summary is stored and will be reused)');
          return;
        }

        const outcomes = deliverSummary({
          store,
          summary,
          deliver: group.deliver,
          vaultDir,
          render: { groupName, tz },
          nowTs: Math.floor(Date.now() / 1000),
          force: Boolean(opts.fresh),
        });
        for (const o of outcomes) console.log(formatOutcome(o));
        if (outcomes.some((o) => o.outcome === 'error')) process.exit(1);
      } finally {
        store.close();
      }
    },
  );

program.parseAsync().catch((e: unknown) => {
  log.error({ err: e }, 'fatal error');
  process.exit(1);
});

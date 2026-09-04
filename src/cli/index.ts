import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { allowedJids, type ConfigError, loadConfig } from '../config/index.js';
import { startListener } from '../listener/index.js';
import { createLogger } from '../shared/index.js';
import { Store } from '../store/index.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file — fine, env vars may be set another way
}

const log = createLogger('cli');

const configPath = resolve(process.env.CONFIG_PATH ?? './config.yaml');
const dataDir = resolve(process.env.DATA_DIR ?? './data');
const dbPath = join(dataDir, 'digest.db');

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
    const store = new Store(dbPath);
    log.info({ configPath, dataDir, allowedGroups: config.groups.length }, 'starting listener');
    const listener = await startListener({ config, store, dataDir });

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
    const rows = store.listGroups();
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

program.parseAsync().catch((e: unknown) => {
  log.error({ err: e }, 'fatal error');
  process.exit(1);
});

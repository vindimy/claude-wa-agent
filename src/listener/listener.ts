import { join } from 'node:path';
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  makeWASocket,
  useMultiFileAuthState,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import { allowedJids, type Config } from '../config/index.js';
import { createLogger } from '../shared/index.js';
import type { Store } from '../store/index.js';
import { extractAction } from './extract.js';

const log = createLogger('listener');

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

export interface ListenerDeps {
  config: Config;
  store: Store;
  dataDir: string;
}

export interface ListenerHandle {
  stop(): Promise<void>;
}

export async function startListener(deps: ListenerDeps): Promise<ListenerHandle> {
  const { config, store, dataDir } = deps;
  const allowed = allowedJids(config);
  const authDir = join(dataDir, 'auth');

  let stopped = false;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let currentSock: ReturnType<typeof makeWASocket> | undefined;

  async function connect(): Promise<void> {
    if (stopped) return;

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version,
      auth: state,
      logger: createLogger('baileys'),
      // no presence broadcast, no read receipts — we are a quiet observer
      markOnlineOnConnect: false,
    });
    currentSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log.info('scan this QR code with WhatsApp (Linked devices > Link a device)');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        attempt = 0;
        log.info('connected');
        void syncGroups(sock);
      }

      if (connection === 'close') {
        // Baileys wraps disconnects in a @hapi/boom error; read it structurally
        const statusCode = (
          lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;
        if (stopped) return;
        if (statusCode === DisconnectReason.loggedOut) {
          // Never loop on QR generation after a logout — require manual re-pairing.
          log.fatal(
            { statusCode },
            'logged out by WhatsApp — delete data/auth and re-pair, listener stopped',
          );
          stopped = true;
          return;
        }
        attempt += 1;
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
        const jitter = delay * (0.5 + Math.random() * 0.5);
        log.warn(
          { statusCode, attempt, delayMs: Math.round(jitter) },
          'disconnected, reconnecting',
        );
        reconnectTimer = setTimeout(() => void connect(), jitter);
      }
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        const jid = msg.key?.remoteJid;
        if (!jid || !isJidGroup(jid) || !allowed.has(jid)) continue;

        const action = extractAction(msg);
        switch (action.action) {
          case 'insert':
            store.insertMessage(action.message);
            store.upsertGroup({ jid, seenTs: action.message.ts });
            log.debug({ jid, id: action.message.id, kind: action.message.kind }, 'stored message');
            break;
          case 'edit':
            store.applyEdit(action.groupJid, action.id, action.body, action.editedTs);
            log.debug({ jid, id: action.id }, 'applied edit');
            break;
          case 'delete':
            store.markDeleted(action.groupJid, action.id);
            log.debug({ jid, id: action.id }, 'marked deleted');
            break;
          case 'skip':
            log.debug({ jid, reason: action.reason }, 'skipped message');
            break;
        }
      }
    });

    sock.ev.on('groups.update', (updates) => {
      const now = Math.floor(Date.now() / 1000);
      for (const u of updates) {
        if (!u.id || !allowed.has(u.id)) continue;
        store.upsertGroup({ jid: u.id, subject: u.subject ?? null, seenTs: now });
      }
    });
  }

  async function syncGroups(sock: ReturnType<typeof makeWASocket>): Promise<void> {
    try {
      const groups = await sock.groupFetchAllParticipating();
      const now = Math.floor(Date.now() / 1000);
      let allowedCount = 0;
      for (const g of Object.values(groups)) {
        store.upsertGroup({
          jid: g.id,
          subject: g.subject,
          participantCount: g.participants?.length ?? null,
          seenTs: now,
        });
        if (allowed.has(g.id)) allowedCount += 1;
      }
      log.info(
        { total: Object.keys(groups).length, allowed: allowedCount },
        'synced participating groups',
      );
    } catch (e) {
      log.warn({ err: e }, 'failed to sync group metadata');
    }
  }

  await connect();

  return {
    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      currentSock?.end(undefined);
      log.info('listener stopped');
    },
  };
}

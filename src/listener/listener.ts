import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  jidNormalizedUser,
  makeWASocket,
  useMultiFileAuthState,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import { allowedJids, type Config } from '../config/index.js';
import type { Transport } from '../delivery/index.js';
import { createLogger, err, ok, tenantAuthDir } from '../shared/index.js';
import type { Store } from '../store/index.js';
import { extractAction, extractContent, toUnixSeconds } from './extract.js';

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

export interface OwnerCommand {
  text: string;
  ts: number;
}

export interface ListenerDeps {
  tenantId: string;
  config: Config;
  store: Store;
  dataDir: string;
  /** Called for live `/…` messages the owner sends to their own chat. */
  onCommand?: (cmd: OwnerCommand) => void;
}

/**
 * Explicit per-tenant session lifecycle. `logged_out` is terminal until a
 * human re-pairs; nothing loops on QR generation.
 */
export type SessionState = 'connecting' | 'pairing' | 'connected' | 'reconnecting' | 'logged_out';

export interface ListenerHandle extends Transport {
  readonly tenantId: string;
  getState(): SessionState;
  stop(): Promise<void>;
}

export async function startListener(deps: ListenerDeps): Promise<ListenerHandle> {
  const { tenantId, config, store, dataDir, onCommand } = deps;
  const log = createLogger('listener', { tenant_id: tenantId });
  const allowed = allowedJids(config);
  const authDir = tenantAuthDir(dataDir, tenantId);

  let stopped = false;
  let attempt = 0;
  let state: SessionState = 'connecting';
  const setState = (next: SessionState) => {
    if (next === state) return;
    log.info({ from: state, to: next }, 'session state');
    state = next;
  };
  let reconnectTimer: NodeJS.Timeout | undefined;
  let currentSock: ReturnType<typeof makeWASocket> | undefined;

  async function connect(): Promise<void> {
    if (stopped) return;

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version,
      auth: state,
      logger: createLogger('baileys', { tenant_id: tenantId }),
      // no presence broadcast, no read receipts — we are a quiet observer
      markOnlineOnConnect: false,
    });
    currentSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        setState('pairing');
        log.info('scan this QR code with WhatsApp (Linked devices > Link a device)');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        attempt = 0;
        setState('connected');
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
          setState('logged_out');
          log.fatal(
            { statusCode, authDir },
            'logged out by WhatsApp — delete the auth dir and re-pair; this tenant is paused',
          );
          stopped = true;
          return;
        }
        setState('reconnecting');
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

    const selfJids = (): Set<string> => {
      const ids = [sock.user?.id, sock.user?.lid].filter((x): x is string => Boolean(x));
      return new Set(ids.map((id) => jidNormalizedUser(id)));
    };

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const msg of messages) {
        const jid = msg.key?.remoteJid;
        if (!jid) continue;

        // Owner commands: live (not history-sync) messages from me, to me.
        if (
          onCommand &&
          type === 'notify' &&
          msg.key?.fromMe &&
          !isJidGroup(jid) &&
          selfJids().has(jidNormalizedUser(jid))
        ) {
          const text = extractContent(msg.message)?.body?.trim();
          if (text?.startsWith('/')) {
            log.info({ command: text.split(/\s+/)[0] }, 'owner command received');
            onCommand({ text, ts: toUnixSeconds(msg.messageTimestamp) });
          }
          continue;
        }

        if (!isJidGroup(jid) || !allowed.has(jid)) continue;

        const action = extractAction(msg);
        switch (action.action) {
          case 'insert':
            store.insertMessage({ tenantId, ...action.message });
            store.upsertGroup({ tenantId, jid, seenTs: action.message.ts });
            log.debug({ jid, id: action.message.id, kind: action.message.kind }, 'stored message');
            break;
          case 'edit':
            store.applyEdit(tenantId, action.groupJid, action.id, action.body, action.editedTs);
            log.debug({ jid, id: action.id }, 'applied edit');
            break;
          case 'delete':
            store.markDeleted(tenantId, action.groupJid, action.id);
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
        store.upsertGroup({ tenantId, jid: u.id, subject: u.subject ?? null, seenTs: now });
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
          tenantId,
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
    tenantId,
    getState: () => state,
    isConnected: () => state === 'connected' && currentSock !== undefined,
    selfJid: () => {
      const id = currentSock?.user?.id;
      return id ? jidNormalizedUser(id) : undefined;
    },
    async sendText(jid, text) {
      const sock = currentSock;
      if (state !== 'connected' || !sock) return err({ tag: 'not-connected' as const });
      try {
        await sock.sendMessage(jid, { text });
        return ok(undefined);
      } catch (e) {
        return err({ tag: 'send' as const, message: e instanceof Error ? e.message : String(e) });
      }
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      currentSock?.end(undefined);
      log.info('listener stopped');
    },
  };
}

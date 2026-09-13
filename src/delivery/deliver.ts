import type { ResolvedDestination } from '../config/index.js';
import { createLogger } from '../shared/index.js';
import { destinationChannel, type Store, type SummaryRecord } from '../store/index.js';
import {
  type RenderContext,
  renderDestinationText,
  renderGroupPostText,
  renderVaultMarkdown,
  renderWhatsAppText,
  vaultRelativePath,
} from './render.js';
import type { DeliveryOutcome } from './types.js';
import { writeVaultNote } from './vault.js';

export function isGroupJid(jid: string): boolean {
  return /^\d+@g\.us$/.test(jid);
}

export interface DeliverArgs {
  store: Store;
  summary: SummaryRecord;
  deliver: { self_dm: boolean; vault: boolean; group: boolean };
  /**
   * Outward targets, already filtered by the trigger gate. Each gets its own
   * `to:<name>` row; the outbox re-checks the name against config at send time.
   */
  destinations?: ResolvedDestination[];
  vaultDir: string;
  render: RenderContext;
  nowTs: number;
  /** Redo every channel even if already delivered (used by `--fresh`). */
  force?: boolean;
}

/**
 * Fan a stored summary out to its channels. Idempotent: a channel that
 * already has a `sent`/`queued` row is not redone. Vault writes happen here;
 * WhatsApp channels are only enqueued and the outbox sends them.
 *
 * `deliver.group` must already be the per-group value the caller wants to act
 * on: this function enqueues a group post whenever it is true, and the outbox
 * re-checks the group's opt-in at send time.
 */
export function deliverSummary(args: DeliverArgs): DeliveryOutcome[] {
  const { store, summary, deliver, vaultDir, render, nowTs, force = false } = args;
  const log = createLogger('delivery', { tenant_id: summary.tenantId });
  const outcomes: DeliveryOutcome[] = [];
  const { tenantId, id: summaryId } = summary;

  if (deliver.vault) {
    const existing = force ? undefined : store.getDelivery(tenantId, summaryId, 'vault');
    if (existing?.status === 'sent') {
      outcomes.push({ channel: 'vault', outcome: 'already', path: existing.target });
    } else {
      const rel = vaultRelativePath(summary, render);
      const written = writeVaultNote(vaultDir, rel, renderVaultMarkdown(summary, render));
      if (written.ok) {
        store.putDelivery({
          tenantId,
          summaryId,
          channel: 'vault',
          status: 'sent',
          target: written.value,
          createdTs: nowTs,
          sentTs: nowTs,
        });
        log.info({ summaryId, path: written.value }, 'wrote vault note');
        outcomes.push({ channel: 'vault', outcome: 'written', path: written.value });
      } else {
        log.error({ summaryId, error: written.error }, 'vault write failed');
        outcomes.push({ channel: 'vault', outcome: 'error', message: written.error.message });
      }
    }
  }

  if (deliver.self_dm) {
    const existing = force ? undefined : store.getDelivery(tenantId, summaryId, 'self_dm');
    if (existing && existing.status !== 'failed') {
      outcomes.push({ channel: 'self_dm', outcome: 'already', status: existing.status });
    } else {
      store.putDelivery({
        tenantId,
        summaryId,
        channel: 'self_dm',
        status: 'queued',
        text: renderWhatsAppText(summary, render),
        createdTs: nowTs,
      });
      log.info({ summaryId }, 'queued self-DM');
      outcomes.push({ channel: 'self_dm', outcome: 'queued' });
    }
  }

  if (deliver.group) {
    if (!isGroupJid(summary.groupJid)) {
      outcomes.push({
        channel: 'group',
        outcome: 'skipped',
        reason: `${summary.groupJid} is not a group JID`,
      });
    } else {
      const existing = force ? undefined : store.getDelivery(tenantId, summaryId, 'group');
      if (existing && existing.status !== 'failed') {
        outcomes.push({ channel: 'group', outcome: 'already', status: existing.status });
      } else {
        store.putDelivery({
          tenantId,
          summaryId,
          channel: 'group',
          status: 'queued',
          target: summary.groupJid,
          text: renderGroupPostText(summary, render),
          createdTs: nowTs,
        });
        log.info({ summaryId, target: summary.groupJid }, 'queued group post');
        outcomes.push({ channel: 'group', outcome: 'queued', target: summary.groupJid });
      }
    }
  }

  for (const dest of args.destinations ?? []) {
    const channel = destinationChannel(dest.name);
    const existing = force ? undefined : store.getDelivery(tenantId, summaryId, channel);
    if (existing && existing.status !== 'failed') {
      outcomes.push({
        channel: 'to',
        name: dest.name,
        outcome: 'already',
        status: existing.status,
      });
      continue;
    }
    store.putDelivery({
      tenantId,
      summaryId,
      channel,
      status: 'queued',
      target: dest.jid,
      text: renderDestinationText(summary, render),
      createdTs: nowTs,
    });
    log.info({ summaryId, destination: dest.name, target: dest.jid }, 'queued destination send');
    outcomes.push({ channel: 'to', name: dest.name, outcome: 'queued', target: dest.jid });
  }

  return outcomes;
}

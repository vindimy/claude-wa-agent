import type { GroupMetadata } from 'baileys';

export interface GroupMetadataCache {
  /** Cached metadata for a group, or undefined when missing or expired. */
  get(jid: string): GroupMetadata | undefined;
  set(meta: GroupMetadata): void;
  /** Replace the whole cache, e.g. after `groupFetchAllParticipating`. */
  setAll(groups: Iterable<GroupMetadata>): void;
  /**
   * Apply a partial `groups.update` payload. Entries not in the cache are
   * ignored: a partial update is not enough to encrypt a send.
   */
  merge(update: Partial<GroupMetadata> & { id?: string }): void;
  /** Drop one entry, e.g. after `group-participants.update`. */
  invalidate(jid: string): void;
  size(): number;
}

/** Participant lists go stale silently if an event is missed; expire anyway. */
export const GROUP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * In-memory group metadata for Baileys' `cachedGroupMetadata` hook. Without
 * it every group send fetches the participant list from the server first.
 * Entries expire after `ttlMs` and are dropped on participant changes.
 */
export function createGroupMetadataCache(
  opts: { ttlMs?: number; now?: () => number } = {},
): GroupMetadataCache {
  const { ttlMs = GROUP_CACHE_TTL_MS, now = () => Date.now() } = opts;
  const entries = new Map<string, { meta: GroupMetadata; at: number }>();

  return {
    get(jid) {
      const e = entries.get(jid);
      if (!e) return undefined;
      if (now() - e.at >= ttlMs) {
        entries.delete(jid);
        return undefined;
      }
      return e.meta;
    },
    set(meta) {
      entries.set(meta.id, { meta, at: now() });
    },
    setAll(groups) {
      entries.clear();
      const at = now();
      for (const meta of groups) entries.set(meta.id, { meta, at });
    },
    merge(update) {
      if (!update.id) return;
      const e = entries.get(update.id);
      if (!e) return;
      e.meta = { ...e.meta, ...update, id: e.meta.id };
    },
    invalidate(jid) {
      entries.delete(jid);
    },
    size: () => entries.size,
  };
}

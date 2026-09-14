import type { DeliveryOutcome } from '../delivery/index.js';

/** One line for `digest schedule`: which channels a scope delivers to. */
export function describeDeliver(d: {
  self_dm: boolean;
  vault: boolean;
  /** Recaps have no group of their own, so this key is absent for them. */
  group?: boolean;
  to: string[];
}): string {
  const on = [
    d.self_dm && 'self-DM',
    d.vault && 'vault',
    d.group && 'GROUP POST',
    ...d.to.map((name) => `→ ${name}`),
  ].filter(Boolean);
  return on.length > 0 ? on.join(', ') : 'nothing';
}

/** One line per delivery channel, printed after `digest summarize`. */
export function formatOutcome(o: DeliveryOutcome): string {
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
      if (o.outcome === 'queued')
        return `group:    queued for ${o.target} — the listener (\`digest run\`) posts it`;
      if (o.outcome === 'already')
        return o.status === 'sent' ? 'group:    already posted' : 'group:    already queued';
      return `group:    skipped — ${o.reason}`;
    case 'to': {
      const label = `to ${o.name}:`.padEnd(10);
      if (o.outcome === 'queued')
        return `${label}queued for ${o.target} — the listener (\`digest run\`) sends it`;
      if (o.outcome === 'already')
        return o.status === 'sent' ? `${label}already sent` : `${label}already queued`;
      return `${label}skipped — ${o.reason}`;
    }
  }
}

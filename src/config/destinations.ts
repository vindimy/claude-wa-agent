import { z } from 'zod';

export const GROUP_JID_RE = /@g\.us$/;
export const groupJid = z.string().regex(GROUP_JID_RE, 'expected a group JID ending in @g.us');

/** Digits only, 7 to 15 of them (E.164 length), or undefined if the input is not a phone number. */
export function normalizePhoneNumber(raw: string): string | undefined {
  const stripped = raw.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d{7,15}$/.test(stripped)) return undefined;
  return stripped;
}

const phoneNumber = z
  .string()
  .trim()
  .refine((v) => normalizePhoneNumber(v) !== undefined, {
    message: 'expected a phone number with 7 to 15 digits, e.g. "+13105551234"',
  });

/**
 * One outward target. Exactly one of `group` or `number`; `strictObject` so a
 * typo such as `numbr:` fails instead of silently producing an empty target.
 */
export const destinationSchema = z.union([
  z.strictObject({ group: groupJid }),
  z.strictObject({ number: phoneNumber }),
]);

export type DestinationConfig = z.infer<typeof destinationSchema>;

export interface ResolvedDestination {
  name: string;
  kind: 'group' | 'number';
  /** Group JID or `<digits>@s.whatsapp.net`. */
  jid: string;
}

export function resolveDestination(
  destinations: Record<string, DestinationConfig>,
  name: string,
): ResolvedDestination | undefined {
  const d = destinations[name];
  if (!d) return undefined;
  if ('group' in d) return { name, kind: 'group', jid: d.group };
  const digits = normalizePhoneNumber(d.number);
  if (!digits) return undefined;
  return { name, kind: 'number', jid: `${digits}@s.whatsapp.net` };
}

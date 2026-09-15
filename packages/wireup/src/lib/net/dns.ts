/**
 * DNS resolution order.
 *
 * Some hosts — Windows boxes behind a VPN, WSL with a generated
 * `/etc/resolv.conf`, Docker's embedded resolver — return `EAI_AGAIN` for the
 * AAAA (IPv6) half of a lookup even though the A (IPv4) records resolve fine.
 * Node's default `verbatim` order surfaces that as a hard, retry-immune
 * failure, and the request never leaves the machine: credentials, model id and
 * permissions are never evaluated.
 *
 * Asking Node to prefer IPv4 sidesteps the broken half. This is the
 * programmatic equivalent of `NODE_OPTIONS=--dns-result-order=ipv4first`,
 * applied from configuration so it survives a new terminal and applies to
 * `next dev` as well as the standalone scripts.
 *
 * Override with `WIREUP_DNS_RESULT_ORDER=verbatim` (Node's default) or
 * `ipv6first` on hosts where IPv6 is the healthy path.
 */

import dns from 'node:dns';

export type DnsResultOrder = 'ipv4first' | 'ipv6first' | 'verbatim';

export const DEFAULT_DNS_RESULT_ORDER: DnsResultOrder = 'ipv4first';

const VALID: readonly DnsResultOrder[] = ['ipv4first', 'ipv6first', 'verbatim'];

let applied: DnsResultOrder | null = null;

/** Parse a `WIREUP_DNS_RESULT_ORDER` value, falling back to the default. */
export function parseDnsResultOrder(value: string | undefined): DnsResultOrder {
  const normalised = value?.trim().toLowerCase();
  if (!normalised) return DEFAULT_DNS_RESULT_ORDER;
  return (VALID as readonly string[]).includes(normalised)
    ? (normalised as DnsResultOrder)
    : DEFAULT_DNS_RESULT_ORDER;
}

/**
 * Apply the configured resolution order to this process. Idempotent, and a
 * no-op when the operator already set `--dns-result-order` via NODE_OPTIONS —
 * an explicit command-line flag always wins.
 */
export function applyDnsResultOrder(value?: string): DnsResultOrder {
  const order = parseDnsResultOrder(value ?? process.env.WIREUP_DNS_RESULT_ORDER);

  if (applied === order) return order;

  if ((process.env.NODE_OPTIONS ?? '').includes('--dns-result-order')) {
    applied = order;
    return order;
  }

  // `setDefaultResultOrder` exists on Node >= 16.4 for dns and >= 17 for
  // dns/promises; guard so an older runtime degrades instead of crashing.
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder(order);
  }

  applied = order;
  return order;
}

/** The order applied to this process, or null if `applyDnsResultOrder` never ran. */
export function currentDnsResultOrder(): DnsResultOrder | null {
  return applied;
}

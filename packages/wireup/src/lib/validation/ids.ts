/** Deterministic-ish id helpers shared by every module. */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomToken(length = 8): string {
  const bytes = new Uint8Array(length);
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  return out;
}

export function createId(prefix = 'id'): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return `${prefix}_${cryptoObj.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
  return `${prefix}_${Date.now().toString(36)}${randomToken(6)}`;
}

export function eventId(): string {
  return createId('evt');
}

export function issueId(): string {
  return createId('iss');
}

export function changeId(): string {
  return createId('chg');
}

export function connectionId(): string {
  return createId('cnx');
}

export function assignmentId(): string {
  return createId('pin');
}

export function selectionId(): string {
  return createId('sel');
}

/** `motor-dc` + 2 -> `motor-dc-2`. Instance ids are unique within a project. */
export function instanceId(componentId: string, index: number): string {
  return `${componentId}-${index}`;
}

export function slugify(value: string, fallback = 'project'): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : fallback;
}

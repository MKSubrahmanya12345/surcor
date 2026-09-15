/**
 * Static source analysis shared by the code generator and the rooting gate.
 *
 * These helpers used to live in `index.ts`; the rooting layer needs them too,
 * and `index.ts` imports the rooting layer, so they live apart to keep the
 * import graph acyclic.
 */

/** Remove comments and string/char literals so brace counting is meaningful. */
export function stripForAnalysis(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;
    const next = source[i + 1];

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += '""';
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

export function braceBalance(source: string): number {
  const stripped = stripForAnalysis(source);
  let balance = 0;
  for (const char of stripped) {
    if (char === '{') balance += 1;
    if (char === '}') balance -= 1;
  }
  return balance;
}

export interface CodeQualityReport {
  usable: boolean;
  reasons: string[];
}

export function assessCodeQuality(content: string): CodeQualityReport {
  const reasons: string[] = [];
  if (content.trim().length < 80) reasons.push('source is essentially empty');
  if (!/void\s+setup\s*\(/.test(content)) reasons.push('missing setup()');
  if (!/void\s+loop\s*\(/.test(content)) reasons.push('missing loop()');

  const balance = braceBalance(content);
  if (balance !== 0) reasons.push(`unbalanced braces (${balance > 0 ? `${balance} unclosed '{'` : `${-balance} extra '}'`})`);

  if (/\b(TODO|FIXME|placeholder|your code here)\b/i.test(content)) reasons.push('contains placeholder/TODO markers');

  return { usable: reasons.length === 0, reasons };
}

export function normalizeConstantName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Does `NAME = VALUE` plausibly declare an MCU pin? Pin constants carry a
 * pin-ish word (PIN, GPIO, SDA, SCL, …) and hold a pin literal (`7`, `A4`,
 * `D7`), never an address (`0x3C`), a size (`128`) or a rate (`9600`).
 */
export function looksLikePinConstant(name: string, value: string): boolean {
  const upper = normalizeConstantName(name);
  const words = upper.split('_').filter(Boolean);
  const pinWords = new Set(['PIN', 'GPIO', 'IO', 'SDA', 'SCL', 'MOSI', 'MISO', 'SCK', 'CS', 'SS', 'TX', 'RX', 'TRIG', 'ECHO', 'DIN', 'DOUT', 'DATA', 'SIG', 'SIGNAL', 'IN1', 'IN2', 'IN3', 'IN4', 'ENA', 'ENB']);
  if (!words.some((word) => pinWords.has(word))) return false;
  if (/ADDR|ADDRESS|WIDTH|HEIGHT|BAUD|COUNT|SIZE|DELAY|TIMEOUT|INTERVAL|MS$|HZ$|RATE/i.test(upper)) return false;
  return /^(?:\d{1,2}|A\d{1,2}|D\d{1,2}|GPIO\d{1,2}|LED_BUILTIN)$/i.test(value.trim());
}

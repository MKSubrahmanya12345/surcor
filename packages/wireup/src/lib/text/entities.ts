/**
 * HTML entities in model-authored text.
 *
 * Bedrock regularly returns prose with `&amp;`, `&lt;` and friends already
 * escaped, because it is writing what it thinks is HTML. That text is stored as
 * markdown and rendered by React, which escapes it a second time — so the user
 * reads "DHT22 (AM2302) temperature &amp; humidity sensor" on the guide page.
 *
 * Unescaping belongs at the boundary where model text enters the system, once,
 * rather than in every renderer. React's own escaping then keeps the output
 * safe: this never produces raw HTML, it only removes a layer that was added
 * too early.
 */

/** Decode the entities a language model typically emits, leaving everything else alone. */
export function unescapeHtmlEntities(value: string): string {
  if (!value.includes('&')) return value;

  let out = value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#0?(\d{1,4});/g, (match, digits: string) => {
      const code = Number.parseInt(digits, 10);
      // Only printable code points; a stray `&#0;` stays as written.
      return Number.isFinite(code) && code > 31 && code < 0x10ffff ? String.fromCodePoint(code) : match;
    });

  /*
   * `&amp;` goes last. Decoding it first would turn `&amp;lt;` into `&lt;` and
   * then into `<`, inventing markup the model never wrote.
   */
  return out.replace(/&amp;/g, '&');
}

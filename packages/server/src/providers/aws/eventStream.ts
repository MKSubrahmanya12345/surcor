/**
 * Decoder for the AWS event-stream binary wire format
 * (`application/vnd.amazon.eventstream`), which is what Bedrock's
 * `converse-stream` endpoint returns instead of server-sent events.
 *
 * Frame layout (all integers big-endian):
 *   uint32 totalByteLength | uint32 headersByteLength | uint32 preludeCrc
 *   headers[headersByteLength] | payload | uint32 messageCrc
 *
 * Header layout: uint8 nameLength | name | uint8 valueType | value, where the
 * value encoding depends on the type (0/1 bool, 2..5 ints, 6 bytes, 7 string,
 * 8 timestamp, 9 uuid).
 */

export type EventStreamHeaderValue = string | number | boolean | Uint8Array;

export interface EventStreamMessage {
  headers: Record<string, EventStreamHeaderValue>;
  payload: Uint8Array;
}

const CRC32_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

/** Standard CRC-32 (IEEE 802.3, reflected) as used by the event-stream framing. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  return parts.reduce((left, right) => concat(left, right), new Uint8Array(0));
}

export function parseEventStreamHeaders(bytes: Uint8Array): Record<string, EventStreamHeaderValue> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8");
  const headers: Record<string, EventStreamHeaderValue> = {};
  let offset = 0;
  while (offset < bytes.length) {
    const nameLength = bytes[offset];
    offset += 1;
    if (offset + nameLength > bytes.length) throw new Error("Truncated event-stream header name.");
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const type = bytes[offset];
    offset += 1;
    let value: EventStreamHeaderValue;
    switch (type) {
      case 0: value = true; break;
      case 1: value = false; break;
      case 2: value = view.getInt8(offset); offset += 1; break;
      case 3: value = view.getInt16(offset); offset += 2; break;
      case 4: value = view.getInt32(offset); offset += 4; break;
      case 5: value = Number(view.getBigInt64(offset)); offset += 8; break;
      case 8: value = Number(view.getBigInt64(offset)); offset += 8; break;
      case 6: case 7: {
        const length = view.getUint16(offset);
        offset += 2;
        if (offset + length > bytes.length) throw new Error("Truncated event-stream header value.");
        const slice = bytes.slice(offset, offset + length);
        offset += length;
        value = type === 7 ? decoder.decode(slice) : slice;
        break;
      }
      case 9: value = bytes.slice(offset, offset + 16); offset += 16; break;
      default: throw new Error(`Unsupported event-stream header value type ${type}.`);
    }
    headers[name] = value;
  }
  return headers;
}

export async function* decodeEventStream(
  body: ReadableStream<Uint8Array>,
  maxMessageBytes = MAX_MESSAGE_BYTES,
): AsyncGenerator<EventStreamMessage> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  try {
    while (true) {
      while (buffer.length >= 12) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const total = view.getUint32(0);
        const headersLength = view.getUint32(4);
        if (total < 16 + headersLength || total > maxMessageBytes) {
          throw new Error(`Event-stream frame length ${total} is out of range.`);
        }
        if (buffer.length < total) break;
        if (crc32(buffer.subarray(0, 8)) !== view.getUint32(8)) {
          throw new Error("Event-stream prelude checksum mismatch.");
        }
        if (crc32(buffer.subarray(0, total - 4)) !== view.getUint32(total - 4)) {
          throw new Error("Event-stream message checksum mismatch.");
        }
        const headers = parseEventStreamHeaders(buffer.subarray(12, 12 + headersLength));
        const payload = buffer.slice(12 + headersLength, total - 4);
        buffer = buffer.subarray(total);
        yield { headers, payload };
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) buffer = concat(buffer, value);
    }
    if (buffer.length) throw new Error("Event stream ended in the middle of a frame.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** JSON payload of a frame, or null when the frame carries no/invalid JSON. */
export function eventPayloadJson(message: EventStreamMessage): Record<string, unknown> | null {
  if (!message.payload.length) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8").decode(message.payload));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch { return null; }
}

export function eventHeaderString(message: EventStreamMessage, name: string): string {
  const value = message.headers[name];
  return typeof value === "string" ? value : "";
}

/**
 * Encodes one event-stream frame. Only used by tests and by future tooling —
 * Forge is a client of Bedrock, never a server — but it keeps the decoder
 * honestly checkable against the documented byte layout.
 */
export function encodeEventStreamMessage(
  headers: Record<string, EventStreamHeaderValue>,
  payload: Uint8Array | string = "",
): Uint8Array {
  const payloadBytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = encoder.encode(name);
    parts.push(Uint8Array.of(nameBytes.length), nameBytes);
    if (value === true) { parts.push(Uint8Array.of(0)); continue; }
    if (value === false) { parts.push(Uint8Array.of(1)); continue; }
    if (typeof value === "string") {
      const bytes = encoder.encode(value);
      const length = new Uint8Array(2);
      new DataView(length.buffer).setUint16(0, bytes.length);
      parts.push(Uint8Array.of(7), length, bytes);
      continue;
    }
    if (typeof value === "number") {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setInt32(0, value);
      parts.push(Uint8Array.of(4), bytes);
      continue;
    }
    const length = new Uint8Array(2);
    new DataView(length.buffer).setUint16(0, value.length);
    parts.push(Uint8Array.of(6), length, value);
  }
  const headerBytes = concatAll(parts);
  const total = 12 + headerBytes.length + payloadBytes.length + 4;
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(frame.subarray(0, 8)));
  frame.set(headerBytes, 12);
  frame.set(payloadBytes, 12 + headerBytes.length);
  view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)));
  return frame;
}

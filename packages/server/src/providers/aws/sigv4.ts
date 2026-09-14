import { createHash, createHmac } from "node:crypto";

/**
 * Minimal AWS Signature Version 4 request signer.
 *
 * Hand-rolled on purpose: Forge talks to Bedrock with `fetch` only, so there is
 * no `@aws-sdk/*` dependency (and nothing native to compile). This implements
 * exactly the subset Bedrock needs — canonical request, string to sign,
 * derived signing key, `Authorization` header.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface SignRequestOptions {
  method: HttpMethod;
  /** Absolute URL. The path is used verbatim for the request line. */
  url: string;
  headers?: Record<string, string>;
  body?: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** Injectable clock, so signing is deterministic under test. */
  now?: Date;
  /** Send `UNSIGNED-PAYLOAD` instead of hashing the body (streaming uploads). */
  unsignedPayload?: boolean;
}

export interface SignedRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Uint8Array | string, data: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(data, "utf8").digest());
}

/**
 * AWS `uriEncode`: percent-encode every octet except the unreserved set
 * `A-Za-z0-9-_.~`, using uppercase hex. `encodeSlash=false` also keeps `/`
 * (used for path segments such as Bedrock inference-profile ARNs).
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    const unreserved = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) || char === "-" || char === "_" || char === "." || char === "~";
    if (unreserved || (char === "/" && !encodeSlash)) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function amzTimestamp(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/** Canonical URI: each path segment uri-encoded (slashes preserved), "/" when empty. */
export function canonicalUri(pathname: string): string {
  const raw = pathname || "/";
  const segments = raw.split("/").map((segment) => {
    if (!segment) return segment;
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* keep the raw segment */ }
    return uriEncode(decoded, false);
  });
  const joined = segments.join("/");
  return joined.startsWith("/") ? joined : `/${joined}`;
}

/** Canonical query string: encoded key/value pairs sorted by key then value. */
export function canonicalQuery(search: string): string {
  const pairs: [string, string][] = [];
  for (const part of search.replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const index = part.indexOf("=");
    const key = index < 0 ? part : part.slice(0, index);
    const value = index < 0 ? "" : part.slice(index + 1);
    const decode = (text: string): string => {
      try { return decodeURIComponent(text.replace(/\+/g, " ")); } catch { return text; }
    };
    pairs.push([uriEncode(decode(key)), uriEncode(decode(value))]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

export function canonicalHeaders(headers: Record<string, string>): {
  canonical: string;
  signed: string;
} {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as [string, string])
    .filter(([name]) => name.length > 0);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    canonical: `${entries.map(([name, value]) => `${name}:${value}`).join("\n")}\n`,
    signed: entries.map(([name]) => name).join(";"),
  };
}

export function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Uint8Array {
  const date = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const regional = hmacSha256(date, region);
  const serviced = hmacSha256(regional, service);
  return hmacSha256(serviced, "aws4_request");
}

/**
 * Returns the full header set to send, including `Authorization`,
 * `x-amz-date`, `x-amz-security-token` (when a session token is present) and
 * `host`. Callers must send these headers verbatim.
 */
export function signRequest(options: SignRequestOptions): SignedRequest {
  const url = new URL(options.url);
  const body = options.body ?? "";
  const { amzDate, dateStamp } = amzTimestamp(options.now ?? new Date());
  const payloadHash = url.protocol === "https:" && options.unsignedPayload
    ? UNSIGNED_PAYLOAD
    : sha256Hex(body);

  const headers: Record<string, string> = { host: url.host };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    const key = name.toLowerCase();
    if (key === "host" || key === "content-length" || key === "connection") continue;
    headers[key] = value;
  }
  headers["x-amz-date"] = amzDate;
  if (options.credentials.sessionToken) headers["x-amz-security-token"] = options.credentials.sessionToken;

  const { canonical, signed } = canonicalHeaders(headers);
  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.search),
    canonical,
    signed,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(options.credentials.secretAccessKey, dateStamp, options.region, options.service))
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization = `${ALGORITHM} Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  const outgoing: Record<string, string> = { ...headers, authorization };
  // `fetch` derives Host from the URL, but Host MUST still be part of the
  // canonical request, so it is signed above and dropped from the wire set.
  delete outgoing.host;
  return { method: options.method, url: options.url, headers: outgoing, body };
}

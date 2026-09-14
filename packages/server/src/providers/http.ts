import type { ProviderResponse, ProviderStreamEvent } from "@forge/shared";

export class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    // Never forward provider response bodies: they can contain request data/keys.
    super(`Provider returned HTTP ${status}.`);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider returned an invalid object.");
  }
  return value as Record<string, unknown>;
}

export function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Provider returned an invalid array.");
  return value;
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function argumentsObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return object(JSON.parse(value || "{}"));
  return value === undefined ? {} : object(value);
}

export function callId(): string { return `call_${crypto.randomUUID().replaceAll("-", "")}`; }

export async function post(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body), signal, redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderHttpError(response.status);
  }
  if (!response.body) throw new Error("Provider returned no response body.");
  return response;
}

async function* lines(response: Response): AsyncGenerator<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.length > 2_097_152) throw new Error("Provider stream event is too large.");
        yield line;
      }
      if (buffer.length > 2_097_152) throw new Error("Provider stream event is too large.");
      if (done) break;
    }
    if (buffer) yield buffer.replace(/\r$/, "");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function* jsonEvents(response: Response, format: "sse" | "ndjson" = "sse"):
AsyncGenerator<Record<string, unknown>> {
  let data = "";
  for await (const line of lines(response)) {
    if (format === "ndjson") {
      if (line.trim()) yield object(JSON.parse(line));
      continue;
    }
    if (line === "") {
      if (data.trim() === "[DONE]") return;
      if (data) yield object(JSON.parse(data));
      data = "";
    } else if (line.startsWith("data:")) {
      data += `${data ? "\n" : ""}${line.slice(5).replace(/^ /, "")}`;
      if (data.length > 2_097_152) throw new Error("Provider stream event is too large.");
    }
  }
  if (data && data.trim() !== "[DONE]") yield object(JSON.parse(data));
}

export async function consumeCompletion(events: AsyncIterable<ProviderStreamEvent>): Promise<ProviderResponse> {
  for await (const event of events) {
    if (event.type === "complete") return event.response;
  }
  throw new Error("Provider stream ended without a complete response.");
}

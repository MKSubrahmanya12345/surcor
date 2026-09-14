import type {
  ProviderAdapter, ProviderConfig, ProviderRequest, ProviderResponse, ProviderStreamEvent, ProviderToolCall,
} from "@forge/shared";
import { argumentsObject, array, callId, consumeCompletion, jsonEvents, object, post, text } from "./http";

export class GeminiProvider implements ProviderAdapter {
  readonly name = "gemini" as const;
  constructor(private readonly config: ProviderConfig) {}

  complete(request: ProviderRequest): Promise<ProviderResponse> {
    return consumeCompletion(this.streamComplete(request));
  }

  async *streamComplete(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    const contents: Record<string, unknown>[] = [];
    for (const message of request.messages) {
      if (message.role === "system") continue;
      const role = message.role === "assistant" ? "model" : "user";
      const parts: Record<string, unknown>[] = [];
      if (message.role === "tool") {
        parts.push({ functionResponse: {
          name: message.name, id: message.toolCallId, response: { result: message.content },
        } });
      } else {
        if (message.content) parts.push({ text: message.content });
        for (const call of message.toolCalls ?? []) {
          parts.push({
            functionCall: { name: call.name, args: call.args, id: call.id },
            ...(call.providerMetadata?.geminiThoughtSignature
              ? { thoughtSignature: call.providerMetadata.geminiThoughtSignature } : {}),
          });
        }
      }
      if (!parts.length) continue;
      const previous = contents.at(-1);
      if (previous?.role === role && Array.isArray(previous.parts)) previous.parts.push(...parts);
      else contents.push({ role, parts });
    }
    const model = encodeURIComponent(this.config.model.replace(/^models\//, ""));
    const response = await post(`${this.config.baseUrl.replace(/\/$/, "")}/models/${model}:streamGenerateContent?alt=sse`, {
      contents,
      systemInstruction: { parts: [{ text: request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n") }] },
      generationConfig: { maxOutputTokens: request.maxTokens ?? 4096 },
      ...(request.tools.length ? {
        tools: [{ functionDeclarations: request.tools.map((tool) => ({
          name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters,
        })) }], toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      } : {}),
    }, { "x-goog-api-key": this.config.apiKey ?? "" }, request.signal);

    let content = "";
    let finishReason = "";
    const toolCalls: ProviderToolCall[] = [];
    for await (const event of jsonEvents(response)) {
      if (event.error) throw new Error("Gemini streaming request failed.");
      if (event.promptFeedback && object(event.promptFeedback).blockReason) throw new Error("Gemini blocked the request.");
      const first = array(event.candidates)[0];
      if (!first) continue;
      const candidate = object(first);
      if (candidate.finishReason) finishReason = text(candidate.finishReason);
      for (const value of array(object(candidate.content ?? {}).parts)) {
        const part = object(value);
        if (part.thought === true) continue;
        if (text(part.text)) {
          content += text(part.text);
          yield { type: "text", delta: text(part.text) };
        }
        if (part.functionCall) {
          const fn = object(part.functionCall);
          toolCalls.push({
            id: text(fn.id) || callId(), name: text(fn.name), args: argumentsObject(fn.args),
            ...(text(part.thoughtSignature) ? {
              providerMetadata: { geminiThoughtSignature: text(part.thoughtSignature) },
            } : {}),
          });
        }
      }
    }
    if (finishReason !== "STOP") throw new Error("Gemini response was interrupted, blocked, or truncated.");
    if (toolCalls.some((call) => !call.name) || (!content && !toolCalls.length)) throw new Error("Gemini returned an empty response.");
    yield { type: "complete", response: { content, toolCalls } };
  }
}

import type {
  ProviderAdapter, ProviderConfig, ProviderRequest, ProviderResponse, ProviderStreamEvent, ProviderToolCall,
} from "@forge/shared";
import { argumentsObject, array, callId, consumeCompletion, jsonEvents, object, post, text } from "./http";

export class OllamaProvider implements ProviderAdapter {
  readonly name = "ollama" as const;
  constructor(private readonly config: ProviderConfig) {}

  complete(request: ProviderRequest): Promise<ProviderResponse> {
    return consumeCompletion(this.streamComplete(request));
  }

  async *streamComplete(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    const response = await post(`${this.config.baseUrl.replace(/\/$/, "")}/api/chat`, {
      model: this.config.model, stream: true,
      messages: request.messages.map((message) => ({
        role: message.role, content: message.content,
        ...(message.role === "tool" ? { tool_name: message.name } : {}),
        ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: call.args },
        })) } : {}),
      })),
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", function: {
        name: tool.name, description: tool.description, parameters: tool.parameters,
      } })) } : {}),
      options: { num_predict: request.maxTokens ?? 4096 },
    }, {}, request.signal);

    let content = "";
    let done = false;
    const calls = new Map<string, ProviderToolCall>();
    for await (const event of jsonEvents(response, "ndjson")) {
      if (event.error) throw new Error("Ollama streaming request failed. Check that its model is installed and supports tools.");
      const message = object(event.message ?? {});
      if (text(message.content)) {
        content += text(message.content);
        yield { type: "text", delta: text(message.content) };
      }
      for (const value of array(message.tool_calls)) {
        const raw = object(value);
        const fn = object(raw.function);
        const key = text(raw.id) || (typeof fn.index === "number" ? String(fn.index) : callId());
        calls.set(key, { id: calls.get(key)?.id ?? (text(raw.id) || callId()), name: text(fn.name), args: argumentsObject(fn.arguments) });
      }
      if (event.done === true) {
        if (event.done_reason === "length") throw new Error("Ollama response was truncated.");
        done = true;
      }
    }
    if (!done) throw new Error("Ollama stream ended before completion.");
    const toolCalls = [...calls.values()];
    if (toolCalls.some((call) => !call.name) || (!content && !toolCalls.length)) throw new Error("Ollama returned an empty response.");
    yield { type: "complete", response: { content, toolCalls } };
  }
}

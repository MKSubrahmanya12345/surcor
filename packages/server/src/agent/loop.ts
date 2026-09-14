import type {
  AgentTurnContext, ChatMessage, ProviderMessage, ProviderResponse, ProviderToolCall, ToolResult,
} from "@forge/shared";
import { executeTool, getToolDefinitions } from "../tools/registry";
import { modePolicy, numberedPlan } from "./modes";

function shorten(content: string, limit: number): string {
  return content.length <= limit ? content : `${content.slice(0, limit)}\n[Context truncated; read a smaller file range if needed.]`;
}

export function conversationMessages(history: ChatMessage[], toolsAllowed: boolean): ProviderMessage[] {
  // Drop entire old user turns, never an isolated tool_result from its tool_call.
  let selected = history.slice();
  const firstUser = selected.findIndex((message) => message.role === "user");
  selected = firstUser < 0 ? [] : selected.slice(firstUser);
  while (JSON.stringify(selected).length > 120_000) {
    const nextUser = selected.findIndex((message, index) => index > 0 && message.role === "user");
    if (nextUser < 0) break;
    selected = selected.slice(nextUser);
  }
  const result: ProviderMessage[] = [];
  const pending = new Map<string, ProviderToolCall>();
  const flushInterrupted = () => {
    for (const call of pending.values()) result.push({
      role: "tool", toolCallId: call.id, name: call.name,
      content: JSON.stringify({ toolCallId: call.id, ok: false, output: "", error: "Execution was interrupted before a result was persisted; do not assume success." }),
    });
    pending.clear();
  };
  const toolLimit = Math.max(1024, Math.min(24_000, Math.floor(64_000 / Math.max(1, selected.filter((message) => message.role === "tool").length))));
  for (const message of selected) {
    if (!toolsAllowed) {
      result.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.role === "tool"
          ? `[Previous tool result, context only]\n${shorten(message.content, toolLimit)}`
          : message.content || "[Previous assistant requested tools.]",
      });
      continue;
    }
    if (message.role === "tool") {
      const call = message.toolCalls?.[0];
      if (!call || !pending.has(call.id)) continue;
      result.push({ role: "tool", toolCallId: call.id, name: call.name, content: shorten(message.content, toolLimit) });
      pending.delete(call.id);
    } else {
      flushInterrupted();
      result.push({ role: message.role, content: message.content, ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}) });
      for (const call of message.toolCalls ?? []) pending.set(call.id, call);
    }
  }
  flushInterrupted();
  return result;
}

export async function runAgentTurn(context: AgentTurnContext): Promise<string | null> {
  const policy = modePolicy(context.mode, context.planApproved);
  // Prompt 6: .forge/rules.md, loaded once at connection time by server.ts and
  // cached in this session's settings row. Prepended so it reads as the first
  // system instruction; the safety policy below still applies.
  const workspaceRules = context.database.getSetting<string | null>(`workspace_rules:${context.sessionId}`);
  const rulesBlock = typeof workspaceRules === "string" && workspaceRules.trim()
    ? `Project rules from .forge/rules.md (user-owned project instructions — follow them unless they conflict with the safety policy below):\n${workspaceRules}\n\n`
    : "";
  const request = () => ({
    messages: [
      { role: "system" as const, content: `${rulesBlock}${policy.instruction}\nWorkspace root: ${context.workspaceRoot}` },
      ...conversationMessages(context.database.listMessages(context.sessionId), policy.toolsAllowed),
    ],
    tools: policy.toolsAllowed ? getToolDefinitions() : [],
    signal: context.signal,
    maxTokens: context.maxTokens,
  });
  const save = (message: ChatMessage) => context.database.appendMessage(context.sessionId, message);

  if (policy.requiresPlan) {
    const messageId = crypto.randomUUID();
    try {
      context.signal.throwIfAborted();
      const response = await context.provider.complete(request());
      context.signal.throwIfAborted();
      if (response.toolCalls.length) throw new Error("Planning response attempted to use tools.");
      const content = numberedPlan(response.content);
      save({ id: messageId, role: "assistant", content, mode: context.mode, createdAt: Date.now() });
      context.database.setPendingPlan(context.sessionId, messageId);
      context.emit({ type: "chat_chunk", messageId, delta: content });
      // Returning ends the turn. Only the WebSocket approve_plan handler can
      // start a new turn with planApproved=true; there is no automatic continuation.
      return messageId;
    } finally { context.emit({ type: "chat_done", messageId }); }
  }

  for (let turn = 0; turn < context.maxTurns; turn++) {
    context.signal.throwIfAborted();
    const messageId = crypto.randomUUID();
    try {
      let response: ProviderResponse | undefined;
      for await (const event of context.provider.streamComplete(request())) {
        context.signal.throwIfAborted();
        if (event.type === "text") context.emit({ type: "chat_chunk", messageId, delta: event.delta });
        else if (event.type === "reset") context.emit({ type: "chat_reset", messageId });
        else { response = event.response; break; }
      }
      if (!response) throw new Error("Provider returned no complete response.");
      // Hard policy enforcement, independent of system prompts/provider behavior.
      if (!policy.toolsAllowed && response.toolCalls.length) throw new Error("Ask mode does not permit tools.");
      if (response.toolCalls.length > context.maxToolCallsPerTurn) throw new Error("Provider exceeded the tool-call limit for one iteration.");
      save({ id: messageId, role: "assistant", content: response.content, mode: context.mode,
        ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}), createdAt: Date.now() });
      if (!response.toolCalls.length) return null;
      for (const toolCall of response.toolCalls) context.emit({ type: "tool_call", toolCall });
      for (const toolCall of response.toolCalls) {
        // executeTool returns a cancelled result for each remaining queued call,
        // preserving provider protocol pairing without executing another handler.
        const result: ToolResult = await executeTool(toolCall, context);
        save({ id: crypto.randomUUID(), role: "tool", content: JSON.stringify(result), mode: context.mode,
          toolCalls: [{ ...toolCall, result }], createdAt: Date.now() });
        context.emit({ type: "tool_result", result });
      }
      context.signal.throwIfAborted();
    } finally { context.emit({ type: "chat_done", messageId }); }
  }
  const id = crypto.randomUUID();
  const content = `Stopped after ${context.maxTurns} agent iterations. Completed tool results are preserved; ask me to continue if more work is needed.`;
  save({ id, role: "assistant", content, mode: context.mode, createdAt: Date.now() });
  context.emit({ type: "chat_chunk", messageId: id, delta: content });
  context.emit({ type: "chat_done", messageId: id });
  return null;
}

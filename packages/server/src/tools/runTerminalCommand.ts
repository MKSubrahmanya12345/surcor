import { stat } from "node:fs/promises";
import { runTerminalCommandArgsSchema, type TerminalOutputStream, type ToolHandler } from "@forge/shared";
import { resolveWorkspacePath } from "./paths";

export const runTerminalCommand: ToolHandler = async (call, context) => {
  const args = runTerminalCommandArgsSchema.parse(call.args);
  const cwd = await resolveWorkspacePath(context.workspaceRoot, args.cwd ?? ".");
  if (!(await stat(cwd)).isDirectory()) throw new Error("Command cwd must be a directory.");
  context.signal.throwIfAborted();
  const windows = process.platform === "win32";
  const shell = windows ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", args.command] : ["/bin/sh", "-c", args.command];
  // setsid lets cancellation terminate the whole one-shot process group on Linux.
  const setsid = !windows ? Bun.which("setsid") : null;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && !/(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key),
  ));
  // This is NOT a sandbox. Commands have the user's OS permissions; cwd only
  // sets the starting directory. It is separate from Electron's interactive PTY.
  const child = Bun.spawn(setsid ? [setsid, ...shell] : shell, {
    cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const stdout = child.stdout.getReader();
  const stderr = child.stderr.getReader();
  let output = "";
  let bytes = 0;
  let truncated = false;
  let timedOut = false;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      if (windows) {
        const killer = Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        void killer.exited.catch(() => undefined);
      } else if (setsid) process.kill(-child.pid, "SIGKILL");
    } catch { /* Process/group may already have exited. */ }
    try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
    void stdout.cancel().catch(() => undefined);
    void stderr.cancel().catch(() => undefined);
  };
  const timeout = Math.min(args.timeoutMs ?? context.commandTimeoutMs, context.commandTimeoutMs);
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
  context.signal.addEventListener("abort", stop, { once: true });
  if (context.signal.aborted) stop();

  const pump = async (reader: ReadableStreamDefaultReader<Uint8Array>, stream: TerminalOutputStream): Promise<void> => {
    const decoder = new TextDecoder();
    const publish = (delta: string) => {
      if (!delta || stopped) return;
      output += delta;
      context.emit({ type: "tool_result_chunk", stream, result: { toolCallId: call.id, ok: true, output: delta } });
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const available = Math.max(0, context.maxOutputBytes - bytes);
        const kept = value.subarray(0, available);
        bytes += kept.byteLength;
        if (kept.byteLength < value.byteLength) truncated = true;
        publish(decoder.decode(kept, { stream: true }));
        // Continue draining discarded bytes so noisy commands cannot deadlock.
      }
      publish(decoder.decode());
    } catch (error) {
      if (!stopped) throw error;
    } finally { reader.releaseLock(); }
  };
  try {
    const [, , exitCode] = await Promise.all([pump(stdout, "stdout"), pump(stderr, "stderr"), child.exited]);
    const error = context.signal.aborted ? "Command cancelled." : timedOut ? `Command timed out after ${timeout} ms.` : exitCode !== 0 ? `Command exited with code ${exitCode}.` : undefined;
    return { toolCallId: call.id, ok: !error, output: output + (truncated ? "\n[Output truncated]\n" : ""), ...(error ? { error } : {}) };
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", stop);
    // Also clean up readers/descendants when a pipe fails after the shell exits.
    stop();
    await child.exited.catch(() => undefined);
  }
};

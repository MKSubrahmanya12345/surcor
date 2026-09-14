import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/**
 * Prompt 6, Part C — one-click UX: the renderer talks to the Bun agent server
 * over ws://localhost:4500, and end users should never start it manually. On
 * launch the main process health-checks the server; only if nothing answers
 * (port closed — a 403 still means "something is listening") does it spawn
 * `bun run packages/server/src/server.ts` as a child process.
 *
 * Dev workflow is unaffected: if you already run the server yourself, the
 * health check passes and nothing is spawned. Set FORGE_SERVER_EXTERNAL=1 to
 * disable auto-start entirely.
 *
 * Packaged builds resolve the server from extraResources (electron-builder.yml
 * copies the `bun build`-bundled single file to <resources>/forge-server/
 * server.js), so no node_modules or workspace install exists at that point.
 * Bun itself is still required on PATH (documented in the README).
 */

let child: ChildProcess | null = null;

function agentHttpBase(): string {
  const raw = process.env.FORGE_AGENT_URL?.trim() || "ws://localhost:4500";
  try {
    const url = new URL(raw);
    url.protocol = url.protocol.replace(/^ws/, "http");
    url.pathname = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "http://localhost:4500";
  }
}

async function serverReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_200);
    try {
      const response = await fetch(`${agentHttpBase()}/health`, { signal: controller.signal });
      // Any HTTP response — even 403 — means a server process is listening.
      return response.status < 500;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

function resolveServerEntry(): { cwd: string; script: string } {
  if (app.isPackaged) {
    // extraResources target from packages/client/electron-builder.yml
    return { cwd: path.join(process.resourcesPath, "forge-server"), script: "server.js" };
  }
  // Dev: app path is <repo>/packages/client; the server runs from the repo
  // root so it finds its .env the same way as a manual `bun run`.
  return { cwd: path.join(app.getAppPath(), "..", ".."), script: path.join("packages", "server", "src", "server.ts") };
}

export async function ensureAgentServer(): Promise<void> {
  if (process.env.FORGE_SERVER_EXTERNAL === "1") return;
  if (await serverReachable()) return;

  const { cwd, script } = resolveServerEntry();
  let spawned: ChildProcess;
  try {
    spawned = spawn("bun", ["run", script], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    console.error(`[forge] Could not auto-start the agent server (is Bun on PATH?): ${error instanceof Error ? error.message : error}`);
    return;
  }
  child = spawned;
  spawned.on("error", (error) => {
    console.error(`[forge] Agent server spawn failed: ${error.message}`);
    child = null;
  });
  spawned.on("exit", (code, signal) => {
    if (child === spawned) child = null;
    if (code) console.error(`[forge] Agent server exited (code ${code}, signal ${signal ?? "none"}).`);
  });
  spawned.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/).filter(Boolean)) {
      console.log(`[forge-agent] ${line}`);
    }
  });
  spawned.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/).filter(Boolean)) {
      console.error(`[forge-agent] ${line}`);
    }
  });
  console.log(`[forge] Auto-started the agent server from ${cwd}.`);
}

export function stopAgentServer(): void {
  const spawned = child;
  child = null;
  if (spawned && !spawned.killed) spawned.kill();
}

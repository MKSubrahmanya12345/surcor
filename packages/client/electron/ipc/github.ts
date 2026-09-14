import { app, ipcMain, safeStorage } from "electron";
import { Octokit } from "@octokit/rest";
import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  IPC,
  type DeviceAuthState,
  type GitHubAuthStatus,
  type GitHubRepo,
  type GitHubSession,
} from "@forge/shared";

/**
 * GitHub OAuth **device flow** is used because a desktop app has no web server
 * to receive a redirect callback: the user approves a short code in their
 * browser and this process polls GitHub until the token is issued.
 *
 * The resulting token is encrypted with Electron's safeStorage (OS keychain /
 * DPAPI / libsecret) before it is written to disk — it is never stored in
 * plaintext.
 */

const SCOPES = ["repo", "read:user", "read:org", "workflow"];
const TOKEN_FILE = "github-token.bin";
const VERIFICATION_TIMEOUT_MS = 20_000;
const MAX_REPOS = 500;

const startAuthPayload = z
  .object({ clientId: z.string().min(1).optional() })
  .strict();

interface VerificationInfo {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

interface PendingAuth {
  verification: VerificationInfo | null;
  settled: { status: "success"; token: string } | { status: "error"; error: string } | null;
}

let pending: PendingAuth | null = null;
let cachedToken: string | null = null;
let cachedSession: GitHubSession | null = null;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const configuredClientId = (): string | null => {
  const fromEnv = process.env.FORGE_GITHUB_CLIENT_ID?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
};

function tokenFilePath(): string {
  return path.join(app.getPath("userData"), TOKEN_FILE);
}

function persistToken(token: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    // fire-and-forget: a failed write only costs us persistence across restarts
    void fs.writeFile(tokenFilePath(), safeStorage.encryptString(token)).catch(() => undefined);
  }
}

export function getGitHubToken(): string | null {
  return cachedToken;
}

async function loadPersistedToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = await fs.readFile(tokenFilePath());
    cachedToken = safeStorage.decryptString(encrypted);
    return cachedToken;
  } catch {
    return null; // no token stored yet (or the keychain changed)
  }
}

async function forgetToken(): Promise<void> {
  cachedToken = null;
  cachedSession = null;
  pending = null;
  await fs.rm(tokenFilePath(), { force: true }).catch(() => undefined);
}

function octokitFor(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: "Forge" });
}

async function sessionFor(token: string): Promise<GitHubSession> {
  if (cachedSession) return cachedSession;
  const { data } = await octokitFor(token).rest.users.getAuthenticated();
  cachedSession = {
    login: data.login,
    name: data.name ?? null,
    avatarUrl: data.avatar_url ?? null,
  };
  return cachedSession;
}

/** Handles both the snake_case and camelCase shapes of the verification payload. */
function normalizeVerification(verification: unknown): VerificationInfo {
  const raw = (verification ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
  };
  const number = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === "number") return value;
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return Number(value);
      }
    }
    return undefined;
  };

  return {
    deviceCode: pick("deviceCode", "device_code") ?? "",
    userCode: pick("userCode", "user_code") ?? "",
    verificationUri: pick("verificationUri", "verification_uri") ?? "https://github.com/login/device",
    expiresIn: number("expiresIn", "expires_in") ?? 900,
    interval: number("interval") ?? 5,
  };
}

function toRepo(repo: Record<string, unknown>): GitHubRepo {
  const string = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    id: Number(repo.id ?? 0),
    name: String(repo.name ?? ""),
    fullName: String(repo.full_name ?? repo.name ?? ""),
    private: Boolean(repo.private),
    cloneUrl: String(repo.clone_url ?? ""),
    htmlUrl: String(repo.html_url ?? ""),
    description: string(repo.description),
    defaultBranch: string(repo.default_branch),
    updatedAt: string(repo.updated_at),
    language: string(repo.language),
  };
}

export function registerGitHubHandlers(): void {
  ipcMain.handle(IPC.GITHUB_STATUS, async (): Promise<GitHubAuthStatus> => {
    const token = await loadPersistedToken();
    if (!token) {
      return { connected: false, session: null, clientIdConfigured: configuredClientId() !== null };
    }
    try {
      const session = await sessionFor(token);
      return { connected: true, session, clientIdConfigured: true };
    } catch {
      await forgetToken();
      return { connected: false, session: null, clientIdConfigured: configuredClientId() !== null };
    }
  });

  ipcMain.handle(IPC.GITHUB_START_AUTH, async (_event, payload: unknown): Promise<DeviceAuthState> => {
    const { clientId: clientIdOverride } = startAuthPayload.parse(payload ?? {});
    const clientId = clientIdOverride ?? configuredClientId();
    if (!clientId) {
      return {
        status: "error",
        error:
          "No GitHub OAuth Client ID configured. Set FORGE_GITHUB_CLIENT_ID before launching Forge, or paste a Client ID below.",
      };
    }

    let resolveVerification: (info: VerificationInfo) => void = () => undefined;
    const verificationReady = new Promise<VerificationInfo>((resolve) => {
      resolveVerification = resolve;
    });

    const auth = createOAuthDeviceAuth({
      clientId,
      scopes: SCOPES,
      onVerification: (verification: unknown) => {
        const info = normalizeVerification(verification);
        if (pending) pending.verification = info;
        resolveVerification(info);
      },
    });

    pending = { verification: null, settled: null };

    const tokenPromise = auth({ type: "oauth" })
      .then((authentication) => {
        const token = (authentication as { token?: unknown }).token;
        if (typeof token !== "string" || token.length === 0) throw new Error("GitHub returned no token.");
        if (pending) pending.settled = { status: "success", token };
        return token;
      })
      .catch((error: unknown) => {
        if (pending) pending.settled = { status: "error", error: errorMessage(error) };
        throw error;
      });

    // Keep the promise "handled" in the background while the renderer polls.
    void tokenPromise
      .then(async (token) => {
        cachedToken = token;
        cachedSession = null;
        persistToken(token);
        await sessionFor(token).catch(() => undefined);
      })
      .catch(() => undefined);

    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), VERIFICATION_TIMEOUT_MS));
    const verification = await Promise.race([verificationReady, timeout]);

    if (!verification) {
      return {
        status: "error",
        error: "Timed out waiting for GitHub to issue a device code. Check your network and try again.",
      };
    }

    return {
      status: "polling",
      userCode: verification.userCode,
      verificationUri: verification.verificationUri,
      expiresIn: verification.expiresIn,
      interval: verification.interval,
    };
  });

  ipcMain.handle(IPC.GITHUB_POLL_AUTH, async (): Promise<DeviceAuthState> => {
    if (!pending) return { status: "idle" };

    if (pending.settled?.status === "success") {
      const token = pending.settled.token;
      const session = await sessionFor(token).catch(() => null);
      const verification = pending.verification;
      pending = null;
      return {
        status: "success",
        userCode: verification?.userCode,
        verificationUri: verification?.verificationUri,
      };
    }

    if (pending.settled?.status === "error") {
      const error = pending.settled.error;
      pending = null;
      return { status: "error", error };
    }

    const verification = pending.verification;
    return {
      status: "pending",
      userCode: verification?.userCode,
      verificationUri: verification?.verificationUri,
      expiresIn: verification?.expiresIn,
      interval: verification?.interval,
    };
  });

  ipcMain.handle(IPC.GITHUB_LIST_REPOS, async (): Promise<{ ok: boolean; repos: GitHubRepo[]; message: string }> => {
    const token = await loadPersistedToken();
    if (!token) return { ok: false, repos: [], message: "Not connected to GitHub." };
    try {
      const octokit = octokitFor(token);
      const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
        per_page: 100,
        sort: "updated",
        direction: "desc",
        affiliation: "owner,organization_member,collaborator",
        visibility: "all",
      });
      return {
        ok: true,
        message: "",
        repos: repos.slice(0, MAX_REPOS).map((repo) => toRepo(repo as unknown as Record<string, unknown>)),
      };
    } catch (error) {
      return { ok: false, repos: [], message: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC.GITHUB_SIGN_OUT, async (): Promise<{ ok: boolean }> => {
    await forgetToken();
    return { ok: true };
  });
}

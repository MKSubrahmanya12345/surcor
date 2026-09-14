import { beforeAll, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { IPC } from "@forge/shared";
import type { DeviceAuthState, GitHubAuthStatus, GitHubRepo } from "@forge/shared";
import { installElectronMock, invoke, userDataDir } from "./harness";

installElectronMock();

// --- fake GitHub -------------------------------------------------------
let authOptions: { clientId: string; scopes?: string[] } | null = null;
let onVerification: ((verification: unknown) => void) | null = null;
let approve: () => void = () => undefined;
let reject: (error: Error) => void = () => undefined;
let octokitAuths: string[] = [];

mock.module("@octokit/auth-oauth-device", () => ({
  createOAuthDeviceAuth: (options: { clientId: string; scopes?: string[]; onVerification: (v: unknown) => void }) => {
    authOptions = options;
    onVerification = options.onVerification;
    return async () => {
      options.onVerification({
        device_code: "device-code-1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 899,
        interval: 0,
      });
      const token = await new Promise<string>((resolve, promiseReject) => {
        approve = () => resolve("gho_supersecret");
        reject = promiseReject;
      });
      return { type: "token", tokenType: "oauth", token };
    };
  },
}));

mock.module("@octokit/rest", () => ({
  Octokit: class {
    rest = {
      users: {
        getAuthenticated: async () => ({
          data: { login: "octoforge", name: "Forge User", avatar_url: "https://github.com/octoforge.png" },
        }),
      },
      repos: { listForAuthenticatedUser: async () => ({ data: [] }) },
    };
    constructor(options: { auth?: string }) {
      octokitAuths.push(options.auth ?? "");
    }
    async paginate() {
      return [
        {
          id: 11,
          name: "alpha",
          full_name: "octoforge/alpha",
          private: false,
          clone_url: "https://github.com/octoforge/alpha.git",
          html_url: "https://github.com/octoforge/alpha",
          description: "first repo",
          default_branch: "main",
          updated_at: "2026-01-02T03:04:05Z",
          language: "TypeScript",
        },
        {
          id: 22,
          name: "secret",
          full_name: "octoforge/secret",
          private: true,
          clone_url: "https://github.com/octoforge/secret.git",
          html_url: "https://github.com/octoforge/secret",
          description: null,
          default_branch: "trunk",
          updated_at: null,
          language: null,
        },
      ];
    }
  },
}));

const tokenFile = () => path.join(userDataDir, "github-token.bin");
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeAll(async () => {
  delete process.env.FORGE_GITHUB_CLIENT_ID;
  const { registerGitHubHandlers } = await import("../../packages/client/electron/ipc/github");
  registerGitHubHandlers();
});

test("github:status starts disconnected with no client id configured", async () => {
  const status = await invoke<GitHubAuthStatus>(IPC.GITHUB_STATUS);
  expect(status.connected).toBe(false);
  expect(status.session).toBeNull();
  expect(status.clientIdConfigured).toBe(false);
});

test("github:startAuth explains what to do when no client id is available", async () => {
  const state = await invoke<DeviceAuthState>(IPC.GITHUB_START_AUTH, {});
  expect(state.status).toBe("error");
  expect(state.error).toContain("FORGE_GITHUB_CLIENT_ID");
});

test("github:startAuth returns the device code and then polls until approved", async () => {
  process.env.FORGE_GITHUB_CLIENT_ID = "Iv1.forgetest";
  const started = await invoke<DeviceAuthState>(IPC.GITHUB_START_AUTH, {});
  expect(started.status).toBe("polling");
  expect(started.userCode).toBe("ABCD-1234");
  expect(started.verificationUri).toBe("https://github.com/login/device");
  expect(authOptions?.clientId).toBe("Iv1.forgetest");
  expect(onVerification).toBeFunction();

  const waiting = await invoke<DeviceAuthState>(IPC.GITHUB_POLL_AUTH);
  expect(waiting.status).toBe("pending");

  approve();
  await tick();

  const done = await invoke<DeviceAuthState>(IPC.GITHUB_POLL_AUTH);
  expect(done.status).toBe("success");
});

test("the token is persisted encrypted, never in plaintext", async () => {
  expect(existsSync(tokenFile())).toBe(true);
  const onDisk = readFileSync(tokenFile()).toString("utf8");
  expect(onDisk).not.toContain("gho_supersecret");
  expect(Buffer.from(onDisk, "base64").toString("utf8")).toBe("gho_supersecret");
});

test("github:status now reports the signed-in user", async () => {
  const status = await invoke<GitHubAuthStatus>(IPC.GITHUB_STATUS);
  expect(status.connected).toBe(true);
  expect(status.session?.login).toBe("octoforge");
  expect(octokitAuths).toContain("gho_supersecret");
});

test("github:listRepos maps the API payload onto GitHubRepo", async () => {
  const result = await invoke<{ ok: boolean; repos: GitHubRepo[] }>(IPC.GITHUB_LIST_REPOS);
  expect(result.ok).toBe(true);
  expect(result.repos).toEqual([
    {
      id: 11,
      name: "alpha",
      fullName: "octoforge/alpha",
      private: false,
      cloneUrl: "https://github.com/octoforge/alpha.git",
      htmlUrl: "https://github.com/octoforge/alpha",
      description: "first repo",
      defaultBranch: "main",
      updatedAt: "2026-01-02T03:04:05Z",
      language: "TypeScript",
    },
    {
      id: 22,
      name: "secret",
      fullName: "octoforge/secret",
      private: true,
      cloneUrl: "https://github.com/octoforge/secret.git",
      htmlUrl: "https://github.com/octoforge/secret",
      description: null,
      defaultBranch: "trunk",
      updatedAt: null,
      language: null,
    },
  ]);
});

test("github:signOut drops the stored token", async () => {
  await invoke(IPC.GITHUB_SIGN_OUT);
  expect(existsSync(tokenFile())).toBe(false);
  const status = await invoke<GitHubAuthStatus>(IPC.GITHUB_STATUS);
  expect(status.connected).toBe(false);
});

test("github:listRepos refuses to work while signed out", async () => {
  const result = await invoke<{ ok: boolean; repos: GitHubRepo[] }>(IPC.GITHUB_LIST_REPOS);
  expect(result.ok).toBe(false);
  expect(result.repos).toEqual([]);
});

test("a rejected device flow surfaces the error and can be retried", async () => {
  const started = await invoke<DeviceAuthState>(IPC.GITHUB_START_AUTH, { clientId: "Iv1.retry" });
  expect(started.status).toBe("polling");
  reject(new Error("access_denied"));
  await tick();
  const failed = await invoke<DeviceAuthState>(IPC.GITHUB_POLL_AUTH);
  expect(failed.status).toBe("error");
  expect(failed.error).toContain("access_denied");
});

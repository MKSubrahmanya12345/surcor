import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AwsCredentials } from "./sigv4";

/**
 * Bedrock credential resolution without the AWS SDK.
 *
 * Order (first match wins):
 *   1. `AWS_BEARER_TOKEN_BEDROCK` — Bedrock API key, no SigV4 at all.
 *   2. Static keys from config/environment (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY).
 *   3. Shared INI profile (`AWS_PROFILE`, default "default") from ~/.aws/credentials
 *      and ~/.aws/config — including `credential_process`, which is how
 *      `aws sso login` setups hand out short-lived keys.
 *
 * IAM roles (EC2 instance metadata, ECS container credentials) are NOT
 * supported: they need an IMDS client, and a desktop editor is not an EC2
 * instance. Set static keys or a profile instead.
 */

export interface AwsAuth {
  kind: "bearer" | "sigv4";
  bearerToken?: string;
  credentials?: AwsCredentials;
  /** Where the credentials came from — logged, never secret. */
  source: string;
  /** Epoch ms; resolve again after this. Absent = long-lived. */
  expiresAt?: number;
}

export interface AwsCredentialSource {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  bearerToken?: string;
  profile?: string;
  env?: Record<string, string | undefined>;
  /** Override of ~/.aws, used by tests. */
  awsDir?: string;
}

type IniFile = Record<string, Record<string, string>>;

/** Minimal INI parser: `[section]` headers and `key = value` pairs. */
export function parseAwsIni(text: string): IniFile {
  const sections: IniFile = {};
  let current: Record<string, string> | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim();
      current = sections[name] ??= {};
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0 || !current) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    let value = line.slice(separator + 1).trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    current[key] = value;
  }
  return sections;
}

function readIni(path: string): IniFile {
  try { return parseAwsIni(readFileSync(path, "utf8")); } catch { return {}; }
}

function profileSections(source: AwsCredentialSource, profile: string): Record<string, string>[] {
  const dir = source.awsDir ?? join(homedir(), ".aws");
  const credentials = readIni(join(dir, "credentials"));
  const config = readIni(join(dir, "config"));
  const found: Record<string, string>[] = [];
  if (credentials[profile]) found.push(credentials[profile]);
  // ~/.aws/config prefixes non-default profiles with "profile ".
  const configKey = profile === "default" ? "default" : `profile ${profile}`;
  if (config[configKey]) found.push(config[configKey]);
  else if (config[profile]) found.push(config[profile]);
  return found;
}

function staticFromSections(sections: Record<string, string>[]): AwsCredentials | undefined {
  for (const section of sections) {
    const accessKeyId = section.aws_access_key_id;
    const secretAccessKey = section.aws_secret_access_key;
    if (accessKeyId && secretAccessKey) {
      return { accessKeyId, secretAccessKey, ...(section.aws_session_token ? { sessionToken: section.aws_session_token } : {}) };
    }
  }
  return undefined;
}

function credentialProcess(sections: Record<string, string>[]): string | undefined {
  for (const section of sections) if (section.credential_process) return section.credential_process;
  return undefined;
}

/**
 * Cheap, synchronous availability check used by config.ts to decide whether
 * `bedrock` belongs in the router's active list. Never runs a subprocess.
 */
export function hasAwsAuth(source: AwsCredentialSource): boolean {
  const env = source.env ?? (process.env as Record<string, string | undefined>);
  if (source.bearerToken || env.AWS_BEARER_TOKEN_BEDROCK) return true;
  if ((source.accessKeyId || env.AWS_ACCESS_KEY_ID) && (source.secretAccessKey || env.AWS_SECRET_ACCESS_KEY)) return true;
  const profile = source.profile || env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE || "default";
  const sections = profileSections(source, profile);
  return Boolean(staticFromSections(sections) ?? credentialProcess(sections));
}

const processCache = new Map<string, AwsAuth>();
const EXPIRY_SAFETY_MS = 60_000;

async function runCredentialProcess(command: string, cacheKey: string): Promise<AwsAuth> {
  const cached = processCache.get(cacheKey);
  if (cached?.expiresAt && cached.expiresAt - EXPIRY_SAFETY_MS > Date.now()) return cached;
  const shell = process.platform === "win32"
    ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
    : ["/bin/sh", "-c", command];
  const child = Bun.spawn(shell, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`AWS credential_process failed (exit ${exitCode}): ${stderr.trim().slice(0, 200) || "no stderr"}`);
  }
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== "object") throw new Error("AWS credential_process returned invalid JSON.");
  const json = parsed as Record<string, unknown>;
  const accessKeyId = typeof json.AccessKeyId === "string" ? json.AccessKeyId : "";
  const secretAccessKey = typeof json.SecretAccessKey === "string" ? json.SecretAccessKey : "";
  if (!accessKeyId || !secretAccessKey) throw new Error("AWS credential_process output is missing AccessKeyId/SecretAccessKey.");
  const sessionToken = typeof json.SessionToken === "string" && json.SessionToken ? json.SessionToken : undefined;
  const expiresAt = typeof json.Expiration === "string" ? Date.parse(json.Expiration) : Number.NaN;
  const auth: AwsAuth = {
    kind: "sigv4",
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
    source: `credential_process (${cacheKey})`,
    ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
  };
  processCache.set(cacheKey, auth);
  return auth;
}

/** Full resolution; may execute the profile's `credential_process`. */
export async function resolveAwsAuth(source: AwsCredentialSource): Promise<AwsAuth> {
  const env = source.env ?? (process.env as Record<string, string | undefined>);
  const bearerToken = source.bearerToken ?? env.AWS_BEARER_TOKEN_BEDROCK;
  if (bearerToken?.trim()) return { kind: "bearer", bearerToken: bearerToken.trim(), source: "AWS_BEARER_TOKEN_BEDROCK" };

  const accessKeyId = source.accessKeyId ?? env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = source.secretAccessKey ?? env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    const sessionToken = source.sessionToken ?? env.AWS_SESSION_TOKEN;
    return {
      kind: "sigv4",
      credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
      source: "environment",
    };
  }

  const profile = source.profile || env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE || "default";
  const sections = profileSections(source, profile);
  const staticCredentials = staticFromSections(sections);
  if (staticCredentials) return { kind: "sigv4", credentials: staticCredentials, source: `profile ${profile}` };

  const command = credentialProcess(sections);
  if (command) return runCredentialProcess(command, profile);

  throw new Error(
    "No Bedrock credentials found. Set AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, " +
    `or configure an AWS profile ("${profile}") in ~/.aws/credentials or ~/.aws/config.`,
  );
}

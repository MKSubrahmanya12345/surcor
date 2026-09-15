import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CadConfig } from "../../packages/server/src/cad/config";
import { resolveArtifactPath, serveCadArtifact } from "../../packages/server/src/cad/artifacts";

/**
 * The artifact route is the only way a CAD model leaves the agent server, so its
 * job is to be boring and strict: files inside Forge's CAD cache, and nothing
 * else — not `..`, not an absolute path elsewhere on disk, not a symlink out.
 */

const cacheConfig = async (): Promise<CadConfig> => {
  const dir = await mkdtemp("/tmp/forge-cad-cache-");
  await mkdir(join(dir, "job1"), { recursive: true });
  await writeFile(join(dir, "job1", "model.glb"), "glTF-bytes");
  await writeFile(join(dir, "job1", "model.step"), "ISO-10303-21;");
  await writeFile(join(dir, "secret.txt"), "not a model");
  await writeFile(join(dir, "job1", "notes.md"), "not served either");
  return { artifactDir: dir } as CadConfig;
};

const requestFor = (url: string): Request => new Request(url);

test("a cached model file is served with a CAD content type", async () => {
  const config = await cacheConfig();
  const response = await serveCadArtifact(requestFor(`http://127.0.0.1:4500/cad/artifact?path=${encodeURIComponent(join(config.artifactDir, "job1", "model.glb"))}`), config);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("model/gltf-binary");
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("glTF-bytes");
});

test("download mode is requested with ?dl=1", async () => {
  const config = await cacheConfig();
  const step = join(config.artifactDir, "job1", "model.step");
  const inline = await serveCadArtifact(requestFor(`http://x/cad/artifact?path=${encodeURIComponent(step)}`), config);
  expect(inline.headers.get("content-disposition")).toBe("inline");
  const attachment = await serveCadArtifact(requestFor(`http://x/cad/artifact?path=${encodeURIComponent(step)}&dl=1`), config);
  expect(attachment.headers.get("content-disposition")).toContain('attachment; filename="model.step"');
});

test("paths outside the CAD cache are refused", async () => {
  const config = await cacheConfig();
  for (const candidate of [
    "/etc/passwd",
    join(config.artifactDir, "secret.txt"),        // inside the dir but not a CAD extension
    join(config.artifactDir, "job1", "..", "..", "etc", "passwd"),
    join(config.artifactDir, "job1", "notes.md"),
    "",
  ]) {
    const response = await serveCadArtifact(requestFor(`http://x/cad/artifact?path=${encodeURIComponent(candidate)}`), config);
    expect([404].includes(response.status) || response.status === 404).toBe(true);
  }
  expect(await resolveArtifactPath(join(config.artifactDir, "job1", "model.step"), config)).toContain("model.step");
});

test("a symlink out of the cache does not become a read primitive", async () => {
  const config = await cacheConfig();
  const outside = await mkdtemp("/tmp/forge-cad-outside-");
  await writeFile(join(outside, "id_ed25519.step"), "private key");
  const link = join(config.artifactDir, "job1", "escape.step");
  await symlink(join(outside, "id_ed25519.step"), link);
  const response = await serveCadArtifact(requestFor(`http://x/cad/artifact?path=${encodeURIComponent(link)}`), config);
  expect(response.status).toBe(404);
});

test("FORGE_SERVER_TOKEN applies to artifacts too, as a query parameter", async () => {
  const config = await cacheConfig();
  const step = join(config.artifactDir, "job1", "model.step");
  const base = `http://x/cad/artifact?path=${encodeURIComponent(step)}`;
  expect((await serveCadArtifact(requestFor(base), config, "s3cret")).status).toBe(403);
  expect((await serveCadArtifact(requestFor(`${base}&token=wrong`), config, "s3cret")).status).toBe(403);
  expect((await serveCadArtifact(requestFor(`${base}&token=s3cret`), config, "s3cret")).status).toBe(200);
});

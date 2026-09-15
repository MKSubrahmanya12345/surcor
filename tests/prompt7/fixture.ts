import { join } from "node:path";

/**
 * Prompt 7's CAD fixtures (flange.step / plate.step / bolt.step) live in
 * `tests/prompt7/fixtures/`. Tests on Linux could read them via
 * `new URL("./fixtures/", import.meta.url).pathname`, but .pathname is a POSIX
 * path (`/E:/surcor/...`) that breaks on Windows, so these helpers exist and
 * every fixture read goes through them.
 */
export const fixturesDir: string = join(import.meta.dir, "fixtures");

/** Full, platform-native path to a named fixture file. */
export const fixturePath = (name: string): string => join(fixturesDir, name);
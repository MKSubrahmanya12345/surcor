import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";

// Vite's native config loader evaluates this file as an ES module, where the
// CommonJS globals do not exist — `import.meta.dirname` is the supported way to
// get this folder (the `??` branch keeps Node < 20.11 working too).
const root = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const fromRoot = (...segments: string[]) => path.resolve(root, ...segments);

const electronOutDir = fromRoot("dist-electron");

/**
 * What the Electron processes must load from disk at runtime instead of
 * bundling:
 *
 * - `electron` and the Node builtins are provided by the runtime itself.
 * - `node-pty` is a native addon that has to be compiled against Electron's ABI
 *   (`bun run rebuild`), so it can never be inlined into a JS bundle.
 *
 * Everything else — `simple-git`, `@octokit/*`, `zod`, `@forge/shared` — *is*
 * bundled. `dist-electron/main.js` therefore does not depend on how
 * `node_modules` happens to be laid out at runtime, and a missing dependency
 * fails the build with a clear Rolldown message instead of throwing
 * `ERR_MODULE_NOT_FOUND` when Electron loads the app.
 */
const external = [
  "electron",
  "electron/main",
  "electron/renderer",
  "electron/common",
  "electron/utility",
  "original-fs",
  "node-pty",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  /^node:/,
];

const electronBuild = {
  outDir: electronOutDir,
  // both bundles land in dist-electron; only `bun run build` cleans `dist`
  emptyOutDir: false,
};

export default defineConfig({
  root,

  build: {
    outDir: fromRoot("dist"),
    emptyOutDir: true,
  },

  optimizeDeps: {
    // xterm's stylesheet is discovered by the dependency scanner, but a CSS file
    // cannot be pre-bundled into the optimizer cache — excluding it keeps Vite
    // serving it directly (and silences "The file does not exist at
    // .vite/deps/@xterm_xterm_css_xterm__css.js").
    exclude: ["@xterm/xterm/css/xterm.css"],
  },

  plugins: [
    react(),

    // `vite-plugin-electron/simple` (rather than two standalone `electron()`
    // plugins) so Electron is started exactly once per rebuild: the main entry
    // owns startup, the preload entry only asks the renderer to reload.
    electron({
      main: {
        entry: fromRoot("electron/main.ts"),
        vite: {
          build: {
            ...electronBuild,
            rolldownOptions: { external },
          },
        },
      },

      preload: {
        input: fromRoot("electron/preload.ts"),
        vite: {
          build: {
            ...electronBuild,
            rolldownOptions: {
              external,
              output: {
                // The renderer is sandboxed (`webPreferences.sandbox: true`), and
                // Electron runs sandboxed preload scripts as plain CommonJS — they
                // get no ESM loader, so an `import`-based preload silently fails
                // and leaves `window.forge` undefined. Keep the `.js` extension
                // too: ESM preloads require `.mjs` *and* `sandbox: false`.
                format: "cjs",
                entryFileNames: "[name].js",
                chunkFileNames: "[name].js",
                assetFileNames: "[name].[ext]",
              },
            },
          },
        },
      },
    }),
  ],
});

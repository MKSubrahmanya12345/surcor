import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";
import path from "node:path";

export default defineConfig({
  root: __dirname,

  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },

  plugins: [
    react(),

    electron({
      entry: path.resolve(__dirname, "electron/main.ts"),
      vite: {
        build: {
          outDir: path.resolve(__dirname, "dist-electron"),
        },
      },
    }),

    electron({
      entry: path.resolve(__dirname, "electron/preload.ts"),
      vite: {
        build: {
          outDir: path.resolve(__dirname, "dist-electron"),
        },
      },
    }),
  ],
});
import { app, BrowserWindow, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerFileSystemHandlers } from "./ipc/fileSystem";
import { registerTerminalHandlers } from "./ipc/terminal";
import { registerGitHandlers } from "./ipc/git";
import { registerGitHubHandlers } from "./ipc/github";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;

// vite-plugin-electron names the bundle `preload.js` when vite runs from the
// package root and `preload.mjs` when it runs from `src/`, so accept either —
// a missing preload would silently leave `window.forge` undefined.
const preloadPath = ["preload.js", "preload.mjs"]
  .map((file) => path.join(__dirname, file))
  .find((candidate) => existsSync(candidate));

if (!preloadPath) {
  throw new Error(
    `No preload bundle found next to ${__dirname}. Run \`bun run build\` from packages/client first.`,
  );
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 520,
    title: "Forge",
    backgroundColor: "#1e1e1e",
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  registerFileSystemHandlers();
  registerTerminalHandlers();
  registerGitHandlers();
  registerGitHubHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

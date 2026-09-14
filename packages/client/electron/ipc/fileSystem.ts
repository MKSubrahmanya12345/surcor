import { dialog, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { IPC, type FileNode } from "@forge/shared";

const pathPayload = z.object({ path: z.string().min(1) }).strict();
const writePayload = z.object({ path: z.string().min(1), content: z.string() }).strict();
const createPayload = z.object({ path: z.string().min(1), isDirectory: z.boolean().optional() }).strict();
const renamePayload = z.object({ oldPath: z.string().min(1), newPath: z.string().min(1) }).strict();

async function listDirectory(directoryPath: string): Promise<FileNode[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.name !== ".DS_Store")
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    })
    .map((entry) => ({
      path: path.join(directoryPath, entry.name),
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
}

export function registerFileSystemHandlers(): void {
  ipcMain.handle(IPC.FS_OPEN_FOLDER, async () => {
    const result = await dialog.showOpenDialog({
      title: "Open Folder",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC.FS_READ_FILE, async (_event, payload: unknown) => {
    const { path: filePath } = pathPayload.parse(payload);
    return fs.readFile(filePath, "utf8");
  });

  ipcMain.handle(IPC.FS_WRITE_FILE, async (_event, payload: unknown) => {
    const { path: filePath, content } = writePayload.parse(payload);
    await fs.writeFile(filePath, content, "utf8");
  });

  ipcMain.handle(IPC.FS_LIST_DIR, async (_event, payload: unknown) => {
    const { path: directoryPath } = pathPayload.parse(payload);
    return listDirectory(directoryPath);
  });

  ipcMain.handle(IPC.FS_CREATE_FILE, async (_event, payload: unknown) => {
    const { path: targetPath, isDirectory } = createPayload.parse(payload);
    if (isDirectory) await fs.mkdir(targetPath, { recursive: false });
    else await fs.writeFile(targetPath, "", { flag: "wx" });
  });

  ipcMain.handle(IPC.FS_DELETE_FILE, async (_event, payload: unknown) => {
    const { path: targetPath } = pathPayload.parse(payload);
    await fs.rm(targetPath, { recursive: true, force: false });
  });

  ipcMain.handle(IPC.FS_RENAME, async (_event, payload: unknown) => {
    const { oldPath, newPath } = renamePayload.parse(payload);
    await fs.rename(oldPath, newPath);
  });
}

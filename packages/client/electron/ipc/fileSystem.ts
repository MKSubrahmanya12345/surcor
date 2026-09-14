import { dialog, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { IPC, type FileNode } from "@forge/shared";

const pathPayload = z.object({ path: z.string().min(1) }).strict();
const writePayload = z.object({ path: z.string().min(1), content: z.string() }).strict();
const createPayload = z.object({ path: z.string().min(1), isDirectory: z.boolean().optional() }).strict();
const renamePayload = z.object({ oldPath: z.string().min(1), newPath: z.string().min(1) }).strict();

/** Turn errno codes into sentences a person can act on in the error toast. */
function friendlyError(error: unknown, target: string): Error {
  const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
  const where = target.length > 120 ? `…${target.slice(-117)}` : target;
  const message = (() => {
    switch (code) {
      case "EEXIST": return `"${path.basename(target)}" already exists.`;
      case "ENOENT": return `"${where}" does not exist.`;
      case "EACCES": case "EPERM": return `Permission denied: ${where}`;
      case "EISDIR": return `"${where}" is a directory.`;
      case "ENOTDIR": return `"${where}" is not a directory.`;
      case "ENOTEMPTY": return `"${path.basename(target)}" is not empty.`;
      case "ENAMETOOLONG": return "That name is too long.";
      case "ELOOP": return "Too many symbolic links.";
      case "EROFS": return "The file system is read-only.";
      case "EBUSY": return `"${path.basename(target)}" is in use.`;
      default: return error instanceof Error ? error.message : String(error);
    }
  })();
  const wrapped = new Error(message);
  // Preserve the code for callers that want to branch on it.
  Object.defineProperty(wrapped, "code", { value: code, enumerable: false });
  return wrapped;
}

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
    try { return await fs.readFile(filePath, "utf8"); }
    catch (error) { throw friendlyError(error, filePath); }
  });

  ipcMain.handle(IPC.FS_WRITE_FILE, async (_event, payload: unknown) => {
    const { path: filePath, content } = writePayload.parse(payload);
    try { await fs.writeFile(filePath, content, "utf8"); }
    catch (error) { throw friendlyError(error, filePath); }
  });

  ipcMain.handle(IPC.FS_LIST_DIR, async (_event, payload: unknown) => {
    const { path: directoryPath } = pathPayload.parse(payload);
    try { return await listDirectory(directoryPath); }
    catch (error) { throw friendlyError(error, directoryPath); }
  });

  ipcMain.handle(IPC.FS_CREATE_FILE, async (_event, payload: unknown) => {
    const { path: targetPath, isDirectory } = createPayload.parse(payload);
    try {
      if (isDirectory) {
        // recursive so "src/new/nested" works from one prompt, but an existing
        // folder is still reported instead of silently succeeding.
        const exists = await fs.access(targetPath).then(() => true, () => false);
        if (exists) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        await fs.mkdir(targetPath, { recursive: true });
      } else {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, "", { flag: "wx" });
      }
    } catch (error) { throw friendlyError(error, targetPath); }
  });

  ipcMain.handle(IPC.FS_DELETE_FILE, async (_event, payload: unknown) => {
    const { path: targetPath } = pathPayload.parse(payload);
    try { await fs.rm(targetPath, { recursive: true, force: false }); }
    catch (error) { throw friendlyError(error, targetPath); }
  });

  ipcMain.handle(IPC.FS_RENAME, async (_event, payload: unknown) => {
    const { oldPath, newPath } = renamePayload.parse(payload);
    try { await fs.rename(oldPath, newPath); }
    catch (error) {
      // "already exists" is about the destination, everything else (a missing
      // source, permissions) is about where the entry is now.
      const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
      throw friendlyError(error, code === "EEXIST" || code === "ENOTEMPTY" ? newPath : oldPath);
    }
  });
}

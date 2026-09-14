import { contextBridge, ipcRenderer } from "electron";
import { IPC, type FileNode } from "@forge/shared";

export interface ForgeAPI {
  openFolder: () => Promise<string | null>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  listDir: (path: string) => Promise<FileNode[]>;
  createFile: (path: string, isDirectory?: boolean) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
}

const api: ForgeAPI = {
  openFolder: () => ipcRenderer.invoke(IPC.FS_OPEN_FOLDER),
  readFile: (path) => ipcRenderer.invoke(IPC.FS_READ_FILE, { path }),
  writeFile: (path, content) => ipcRenderer.invoke(IPC.FS_WRITE_FILE, { path, content }),
  listDir: (path) => ipcRenderer.invoke(IPC.FS_LIST_DIR, { path }),
  createFile: (path, isDirectory) => ipcRenderer.invoke(IPC.FS_CREATE_FILE, { path, isDirectory }),
  deleteFile: (path) => ipcRenderer.invoke(IPC.FS_DELETE_FILE, { path }),
  rename: (oldPath, newPath) => ipcRenderer.invoke(IPC.FS_RENAME, { oldPath, newPath }),
};

contextBridge.exposeInMainWorld("forge", api);

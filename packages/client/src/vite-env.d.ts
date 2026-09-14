/// <reference types="vite/client" />

import type { ForgeAPI } from "../electron/preload";

declare global {
  interface Window {
    forge: ForgeAPI;
  }
}

export {};

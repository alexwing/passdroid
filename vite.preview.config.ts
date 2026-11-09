import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Browser-only preview: Tauri modules are swapped for mocks in src/dev/, so the
// UI runs in a plain browser with a fake "Demo" vault. Not used by `npm run build`.
const mock = (file: string) => fileURLToPath(new URL(`./src/dev/${file}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/core$/, replacement: mock("core.ts") },
      { find: /^@tauri-apps\/api\/window$/, replacement: mock("window.ts") },
      { find: /^@tauri-apps\/api\/path$/, replacement: mock("path.ts") },
      { find: /^@tauri-apps\/plugin-dialog$/, replacement: mock("dialog.ts") },
      { find: /^@tauri-apps\/plugin-fs$/, replacement: mock("fs.ts") },
      { find: /^@tauri-apps\/plugin-opener$/, replacement: mock("opener.ts") },
    ],
  },
  server: {
    port: 1421,
    strictPort: false,
  },
});

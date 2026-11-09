import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import baseConfig from "./vite.config";

// Config de Vite solo para el smoke de Playwright: sirve la entrada e2e (e2e/app),
// no la app de Tauri. Reutiliza vite.config.ts (plugin de React incluido) y
// vite.config.ts no se modifica.
const repoRoot = fileURLToPath(new URL(".", import.meta.url));

export default mergeConfig(
  baseConfig,
  defineConfig({
    root: fileURLToPath(new URL("./e2e/app", import.meta.url)),
    server: {
      port: 1421,
      strictPort: true,
      fs: {
        allow: [repoRoot],
      },
    },
  }),
);

import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Reutiliza la config de Vite de la app (plugin de React incluido) y solo añade
// lo de test. vite.config.ts no se modifica.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./src/testing/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
    },
  }),
);

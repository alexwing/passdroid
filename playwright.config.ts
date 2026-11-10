import { defineConfig, devices } from "@playwright/test";

const PORT = 1421;
const BASE_URL = `http://localhost:${PORT}`;

// Smoke e2e contra la UI real en Chromium, servida por vite.e2e.config.ts con la IPC falsa.
export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npx vite --config vite.e2e.config.ts",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
  },
});

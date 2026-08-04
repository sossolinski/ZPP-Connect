import { defineConfig, devices } from "@playwright/test";

delete process.env.NO_COLOR;

const apiPort = Number(process.env.PLAYWRIGHT_API_PORT ?? 4100);
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 4173);
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${apiPort}/api`;
const webUrl = process.env.PLAYWRIGHT_WEB_URL ?? `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./tests/smoke",
  timeout: 30_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: webUrl,
    trace: "retain-on-failure"
  },
  webServer: [
    {
      command: `NODE_ENV=test PERSISTENCE_MODE=memory AUTH_MODE=dev DATABASE_URL= API_PORT=${apiPort} APP_ORIGIN=${webUrl} LOG_LEVEL=silent npm run dev -w @zpp/api`,
      url: `${apiUrl}/health`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI
    },
    {
      command: `VITE_API_URL=${apiUrl} VITE_DEFAULT_USER_EMAIL=coordinator@lot.pl npm run dev -w @zpp/web -- --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: webUrl,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI
    }
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});

import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const headers = { "x-user-email": "coordinator@lot.pl" };

test("exposes only the retained operational product scope", async ({ page }) => {
  await login(page, "coordinator@lot.pl");

  await expect(page.getByRole("link", { name: "Training", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Readiness", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Exercise", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /Operations/ }).click();
  await expect(page.getByRole("link", { name: "Documents", exact: true })).toBeVisible();

  for (const path of ["training/courses", "readiness/summary", "exercise/injects"]) {
    expect((await page.request.get(`${apiUrl}/${path}`, { headers })).status()).toBe(404);
  }
  const readiness = await page.request.get(`${apiUrl}/health/readiness`, { headers });
  expect(readiness.status()).toBe(200);
  await expect(readiness.json()).resolves.toMatchObject({ ready: true });

  await page.goto("/sessions");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New Session" });
  await expect(dialog.getByLabel("Session type")).toHaveValue("REAL");
  await expect(dialog.getByLabel("Session type")).toBeDisabled();
});

test("does not publish retired permissions in administration", async ({ page }) => {
  const response = await page.request.get(`${apiUrl}/admin/capabilities`, { headers: { "x-user-email": "admin@lot.pl" } });
  expect(response.status()).toBe(200);
  const body = await response.json() as { data: Array<{ id: string }> };
  expect(body.data.some(({ id }) => /^(training|readiness|exercise):/.test(id))).toBe(false);
});

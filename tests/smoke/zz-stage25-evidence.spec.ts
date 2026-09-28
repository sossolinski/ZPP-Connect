import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { login } from "./helpers";

const db = new PrismaClient();
const marker = `F25-BROWSER-${randomUUID().slice(0, 8)}`;
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
let incident: { id: string; operationalId: string };

test.beforeAll(async () => {
  const coordinator = await db.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" } });
  incident = await db.session.create({ data: { operationalId: marker, mode: "REAL", status: "Draft", eventType: "Evidence browser workflow", createdById: coordinator.id } });
  await db.incidentAssignment.create({ data: { incidentId: incident.id, userId: coordinator.id, function: "Evidence browser", createdById: coordinator.id } });
});

test.afterAll(async () => { await db.$disconnect(); });

test("uploads, lists, downloads and withdraws exact incident evidence", async ({ page }) => {
  const bytes = Buffer.from(`%PDF-1.4\n% ${marker}\n%%EOF\n`, "utf8");
  await login(page, "coordinator@lot.pl");
  await page.evaluate(id => localStorage.setItem("zpp:activeSessionId", id), incident.id);
  await page.goto("/evidence");
  await expect(page.getByTestId("evidence-workspace")).toBeVisible();
  await page.getByLabel("Evidence file").setInputFiles({ name: "incident source.pdf", mimeType: "application/pdf", buffer: bytes });
  await page.getByLabel("Category").selectOption("Authority correspondence");
  await page.getByLabel("Description").fill("Browser-retained authority source");
  await page.getByRole("button", { name: "Upload retained evidence" }).click();
  await expect(page.getByText("Browser-retained authority source")).toBeVisible();
  await expect(page.getByText(/SHA-256:/)).toBeVisible();

  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download verified file" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("incident source.pdf");
  const downloadedBytes = await readFile((await download.path())!);
  expect(downloadedBytes).toEqual(bytes);
  expect(createHash("sha256").update(downloadedBytes).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));

  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  await page.getByLabel("Withdrawal reason").fill("Superseded by authoritative source");
  await page.getByRole("button", { name: "Confirm withdrawal" }).click();
  await expect(page.getByText("Superseded by authoritative source")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download verified file" })).toHaveCount(0);
});

test("hides evidence navigation and rejects direct API access for an unauthorized observer", async ({ page }) => {
  await login(page, "viewer@lot.pl");
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Incident Evidence" })).toHaveCount(0);
  const denied = await page.request.get(`${apiUrl}/sessions/${incident.id}/evidence`, { headers: { "x-user-email": "viewer@lot.pl" } });
  expect(denied.status()).toBe(403);
});


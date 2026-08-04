import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;

const noOperationalCaseDetail = /\b(?:CASE|TEC|FAM|PAX|MAT|REQ)-2026-|Anna Kowalska|Piotr Kowalski|Kowalski, Piotr/;
const noTechnicalStorageCopy = /demo api|demo mode|in-memory|reset on restart|database not connected|source not connected|temporary storage|database-backed|non-database|data-source|static sample/i;

test.describe("Stage 3G1 security containment", () => {
  test("keeps Dashboard summaries within the actor's authoritative sources", async ({ request }) => {
    for (const email of ["security@lot.pl", "zpp@lot.pl", "volunteer@lot.pl", "tec-leader@lot.pl", "viewer@lot.pl"]) {
      const response = await request.get(`${apiUrl}/dashboard?sessionId=ses-demo-1`, {
        headers: { "x-user-email": email }
      });
      expect(response.status(), email).toBe(200);
      const body = await response.json();
      expect(body.kpis, email).toEqual({});
      expect(body.priorityQueue, email).toEqual({});
      expect(body.status, email).toEqual({});
      expect(JSON.stringify(body), email).not.toMatch(noOperationalCaseDetail);
    }

    const tecResponse = await request.get(`${apiUrl}/dashboard?sessionId=ses-demo-1`, {
      headers: { "x-user-email": "tec@lot.pl" }
    });
    expect(tecResponse.status()).toBe(200);
    const tecBody = await tecResponse.json();
    expect(tecBody.kpis).toMatchObject({
      enquiries: expect.any(Number),
      familyRecords: expect.any(Number),
      openRequests: expect.any(Number)
    });
    expect(tecBody.kpis).not.toHaveProperty("passengerRecords");
    expect(tecBody.kpis).not.toHaveProperty("matchingRecords");
    expect(tecBody.priorityQueue).not.toHaveProperty("unresolvedHolds");
    expect(tecBody.priorityQueue).not.toHaveProperty("pendingMatching");

    const coordinatorResponse = await request.get(`${apiUrl}/dashboard?sessionId=ses-demo-1`, {
      headers: { "x-user-email": "coordinator@lot.pl" }
    });
    expect(coordinatorResponse.status()).toBe(200);
    const coordinatorBody = await coordinatorResponse.json();
    expect(Object.keys(coordinatorBody.priorityQueue)).toEqual(expect.arrayContaining([
      "unlinkedEnquiries",
      "unverifiedFamily",
      "unresolvedHolds",
      "pendingMatching",
      "urgentRequests"
    ]));
  });

  test("shows a ZPP Group Leader only their assigned group and roster scope", async ({ page }) => {
    await login(page, "zpp@lot.pl");
    await page.goto("/groups");

    await expect(page.getByRole("heading", { name: "Groups", exact: true })).toBeVisible();
    await expect(page.getByText("Family Assistance Alpha")).toBeVisible();
    await expect(page.getByText("TEC Evening Team")).toHaveCount(0);
    await expect(page.getByText("Welfare Support Reserve")).toHaveCount(0);

    await page.goto("/rostering");
    await expect(page.getByRole("heading", { name: "Rostering", exact: true })).toBeVisible();
    await expect(page.getByText("Family Assistance Centre morning support")).toBeVisible();
    await expect(page.getByText("Telephone Enquiry Center evening supervisor")).toHaveCount(0);
    await expect(page.getByText("Airport Reception Support cover")).toHaveCount(0);
    await expect(page.locator('[aria-label^="Current session EXERCISE"]:visible')).toHaveCount(1);
    await expect(page.locator("body")).not.toContainText(noTechnicalStorageCopy);
  });

  test("exposes only Manifest CSV and rejects Rostering mutations without an explicit Session", async ({ page, request }) => {
    await login(page, "admin@lot.pl");
    await page.goto("/files-import");

    const importType = page.getByLabel("Import type");
    await expect(importType).toHaveValue("manifest");
    await expect(importType.locator("option")).toHaveText(["Manifest CSV"]);
    const fileInput = page.getByLabel("File");
    await expect(fileInput).toHaveAttribute("accept", ".csv,text/csv");
    await expect(page.locator("body")).not.toContainText(noTechnicalStorageCopy);

    const shift = {
      groupId: "grp-2026-000001",
      title: "Stage 3G1 browser contract",
      duty: "Scope verification",
      functionName: "Family Assistance Team",
      startAt: "2026-08-20T08:00:00.000Z",
      endAt: "2026-08-20T12:00:00.000Z"
    };
    const missingSession = await request.post(`${apiUrl}/roster-shifts`, {
      headers: { "content-type": "application/json", "x-user-email": "coordinator@lot.pl" },
      data: shift
    });
    expect(missingSession.status()).toBe(400);

    const unknownSession = await request.post(`${apiUrl}/roster-shifts`, {
      headers: { "content-type": "application/json", "x-user-email": "coordinator@lot.pl" },
      data: { ...shift, sessionId: "unknown-session" }
    });
    expect(unknownSession.status()).toBe(404);
  });
});

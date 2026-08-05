import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const coordinatorHeaders = { "content-type": "application/json", "x-user-email": "coordinator@lot.pl" };
const adminHeaders = { "content-type": "application/json", "x-user-email": "admin@lot.pl" };
const restrictedUserIds = [
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
  "00000000-0000-4000-8000-000000000006"
];

type TestSession = { id: string; operationalId: string; status: string; flightNumber?: string };

async function sessions(page: Page) {
  const response = await page.request.get(`${apiUrl}/sessions?limit=200`, { headers: coordinatorHeaders });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).data as TestSession[];
}

async function ensureSession(page: Page, flightNumber: string) {
  const existing = (await sessions(page)).find((session) => session.flightNumber === flightNumber && session.status !== "Closed");
  if (existing) return existing;
  const response = await page.request.post(`${apiUrl}/sessions`, {
    headers: coordinatorHeaders,
    data: {
      mode: "EXERCISE",
      status: "Active",
      eventType: "Exercise",
      flightNumber,
      route: "WAW-TEST",
      airportLocation: "Stage 2A browser test",
      description: "Ephemeral browser-test session"
    }
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as TestSession;
}

async function closeSessionViaApi(page: Page, id: string, note: string) {
  const response = await page.request.post(`${apiUrl}/sessions/${id}/close`, {
    headers: coordinatorHeaders,
    data: { notes: note }
  });
  expect(response.ok()).toBeTruthy();
}

async function grantRestrictedPersonasAccess(page: Page, sessionId: string) {
  for (const userId of restrictedUserIds) {
    const response = await page.request.post(`${apiUrl}/sessions/${sessionId}/assignments`, {
      headers: adminHeaders,
      data: { userId, function: "Stage 2A role-aware session test" }
    });
    expect([201, 409]).toContain(response.status());
  }
}

async function useSession(page: Page, session: TestSession) {
  await expect
    .poll(async () => {
      const visibleSessions = await sessions(page);
      return visibleSessions.some((item) => item.id === session.id || item.operationalId === session.operationalId);
    })
    .toBe(true);
  await page.goto(`/sessions?focus=${encodeURIComponent(session.operationalId)}`);
  const row = page.getByRole("row").filter({ hasText: session.operationalId });
  await expect(row).toBeVisible();
  const action = row.getByRole("button", { name: "Use this session" });
  if (!(await row.getByText("Current session", { exact: true }).count())) {
    await expect(action).toBeVisible();
    await action.click();
  }
  await expect(page.locator(`[aria-label*="Current session EXERCISE ${session.operationalId}"]:visible`)).toHaveCount(1);
}

test.describe.serial("Stage 2A session integrity", () => {
  test("selects and persists an active session with role-aware desktop and mobile controls", async ({ page }) => {
    const first = await ensureSession(page, "S2A-SELECT-A");
    const second = await ensureSession(page, "S2A-SELECT-B");
    await grantRestrictedPersonasAccess(page, first.id);
    await grantRestrictedPersonasAccess(page, second.id);

    await login(page);
    await useSession(page, first);
    await expect(page.getByRole("row").filter({ hasText: first.operationalId }).getByText("Current session")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: first.operationalId }).getByRole("button", { name: "Use this session" })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("zpp:activeSessionId"))).toBe(first.id);
    await page.reload();
    await expect(page.locator(`[aria-label*="Current session EXERCISE ${first.operationalId}"]:visible`)).toHaveCount(1);

    for (const [email, maySelect] of [
      ["admin@lot.pl", true],
      ["coordinator@lot.pl", true],
      ["tec@lot.pl", false],
      ["zpp@lot.pl", false],
      ["volunteer@lot.pl", false],
      ["viewer@lot.pl", false]
    ] as const) {
      await login(page, email);
      await page.goto("/sessions");
      if (maySelect) await expect(page.getByRole("button", { name: "Use this session" }).first()).toBeVisible();
      else await expect(page.getByRole("button", { name: "Use this session" })).toHaveCount(0);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await useSession(page, second);
    await expect(page.locator(`[aria-label*="Current session EXERCISE ${second.operationalId}"]:visible`)).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  });

  test("removes controlled states from generic forms while keeping dedicated actions", async ({ page }) => {
    await login(page);
    const original = (await sessions(page)).find((session) => session.id === "ses-demo-1");
    expect(original).toBeTruthy();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await useSession(page, original!);

    await page.getByRole("button", { name: "New" }).click();
    const sessionDrawer = page.getByRole("dialog", { name: "New Session" });
    await expect(sessionDrawer.getByLabel("Status").getByRole("option", { name: "Closed", exact: true })).toHaveCount(0);
    await sessionDrawer.getByRole("button", { name: "Close" }).click();

    await page.goto("/tec-intake");
    await page.getByRole("button", { name: "New enquiry" }).click();
    const enquiryDrawer = page.getByRole("dialog", { name: "New TEC enquiry" });
    await expect(enquiryDrawer.getByLabel("Status").getByRole("option", { name: "Closed", exact: true })).toHaveCount(0);
    await enquiryDrawer.getByRole("button", { name: "Close" }).click();

    await page.goto("/family-nok");
    await page.getByRole("button", { name: "New family record" }).click();
    const familyDrawer = page.getByRole("dialog", { name: "New family/NOK record" });
    await expect(familyDrawer.getByLabel("Verification status")).toHaveCount(0);
    await familyDrawer.getByRole("button", { name: "Close" }).click();

    await page.goto("/requests");
    await page.getByRole("button", { name: "New request" }).click();
    const requestDrawer = page.getByRole("dialog", { name: "New support request" });
    await expect(requestDrawer.getByLabel("Approval status").getByRole("option", { name: "Approved", exact: true })).toHaveCount(0);
    await expect(requestDrawer.getByLabel("Approval status").getByRole("option", { name: "Rejected", exact: true })).toHaveCount(0);
    for (const state of ["Assigned", "In progress", "Waiting", "Done", "Closed", "Cancelled"]) {
      await expect(requestDrawer.getByLabel("Status").getByRole("option", { name: state, exact: true })).toHaveCount(0);
    }
    await requestDrawer.getByRole("button", { name: "Close" }).click();
    await page.getByRole("row").filter({ hasText: "REQ-2026-000001" }).getByRole("button", { name: "Edit" }).click();
    const existingRequestDrawer = page.getByRole("dialog", { name: "Edit support request" });
    const controlledRequestStatus = existingRequestDrawer.locator("select:disabled").filter({ has: page.locator('option[value="Assigned"]') });
    await expect(controlledRequestStatus).toHaveCount(1);
    await expect(controlledRequestStatus).toHaveValue("Assigned");
    await existingRequestDrawer.getByRole("button", { name: "Close" }).first().click();

    await page.goto("/assignments");
    await page.getByRole("button", { name: "New" }).click();
    const assignmentDrawer = page.getByRole("dialog", { name: "New Assignment" });
    await expect(assignmentDrawer.getByLabel("Status")).toHaveCount(0);
    await expect(assignmentDrawer.getByLabel("Owner")).toHaveCount(0);
    await expect(assignmentDrawer.getByText("Current status")).toBeVisible();
    await assignmentDrawer.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("row").filter({ hasText: "Prepare welfare room briefing note" }).getByRole("button", { name: "Start" })).toBeVisible();
    await page.getByRole("row").filter({ hasText: "Review role card access levels" }).getByRole("button", { name: "View" }).click();
    const completedAssignmentDrawer = page.getByRole("dialog", { name: "Edit Assignment" });
    await expect(completedAssignmentDrawer.getByLabel("Status")).toHaveCount(0);
    await expect(completedAssignmentDrawer.getByText("Completed", { exact: true }).first()).toBeVisible();
    await expect(completedAssignmentDrawer.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await completedAssignmentDrawer.getByRole("button", { name: "Close" }).click();

    await page.goto("/matching");
    await page.getByRole("button", { name: "New" }).click();
    const matchDrawer = page.getByRole("dialog", { name: "Create Potential Match" });
    await expect(matchDrawer.getByLabel("Status")).toHaveCount(0);
    await expect(matchDrawer.getByText("Potential match", { exact: true })).toBeVisible();
    await expect(matchDrawer.getByText("No hold", { exact: true })).toBeVisible();
    await matchDrawer.getByRole("button", { name: "Close" }).click();
    await page.getByText("MAT-2026-000001", { exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Verify" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear" }).first()).toBeVisible();

    await page.goto("/exercise");
    await expect(page.getByText("Initial status")).toBeVisible();
    await expect(page.getByLabel("Status")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create inject" })).toBeEnabled();
  });

  test("blocks stale drawer writes and reconciles active-session closure with and without a fallback", async ({ page }) => {
    const first = await ensureSession(page, "S2A-SELECT-A");
    const second = await ensureSession(page, "S2A-SELECT-B");
    await login(page);
    await useSession(page, first);

    await page.goto("/tec-intake");
    await page.getByRole("button", { name: "New enquiry" }).click();
    const drawer = page.getByRole("dialog", { name: "New TEC enquiry" });
    await drawer.getByLabel("Caller name").fill("Stale drawer attempt");
    let createRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/enquiries")) createRequests += 1;
    });
    await closeSessionViaApi(page, first.id, "Closed externally during stale drawer test");
    await drawer.getByRole("button", { name: "Save enquiry" }).click();
    await expect(page.locator(`[aria-label*="Current session EXERCISE ${second.operationalId}"]:visible`)).toHaveCount(1);
    expect(createRequests).toBe(0);
    const staleRows = await page.request.get(`${apiUrl}/enquiries?sessionId=${encodeURIComponent(first.id)}`, { headers: coordinatorHeaders });
    expect(((await staleRows.json()).data as unknown[]).length).toBe(0);

    await page.goto("/sessions");
    const secondRow = page.getByRole("row").filter({ hasText: second.operationalId });
    await secondRow.getByRole("button", { name: "Close session" }).click();
    await page.getByLabel("Closure note").fill("Second session closed with fallback available");
    await page.getByRole("button", { name: "Close session" }).last().click();
    await expect(page.getByText(new RegExp(`${second.operationalId} was closed.*SES-2026-001 is now the active session`))).toBeVisible();
    await expect(page.locator('[aria-label*="Current session EXERCISE SES-2026-001"]:visible')).toHaveCount(1);

    const originalRow = page.getByRole("row").filter({ hasText: "SES-2026-001" });
    await originalRow.getByRole("button", { name: "Close session" }).click();
    await page.getByLabel("Closure note").fill("Only eligible session closed for no-session verification");
    await page.getByRole("button", { name: "Close session" }).last().click();
    await expect(page.getByText(/No eligible session remains/)).toBeVisible();
    await expect(page.locator('[aria-label^="No active session"]:visible')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Use this session" })).toHaveCount(0);
    await expect(page.getByText("Read-only").first()).toBeVisible();

    await page.goto("/tec-intake");
    await expect(page.getByText(/No open operational session is selected/)).toBeVisible();
    await expect(page.getByRole("button", { name: "New enquiry" })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/requests");
    await expect(page.getByText(/No open operational session is selected/)).toBeVisible();
    await expect(page.getByRole("button", { name: "New request" })).toHaveCount(0);
    await expect(page.locator('[aria-label^="No active session"]:visible')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);

    const recovery = await ensureSession(page, "S2A-RECOVERY");
    await page.goto("/sessions");
    await useSession(page, recovery);
    await expect(page.locator(`[aria-label*="Current session EXERCISE ${recovery.operationalId}"]:visible`)).toHaveCount(1);
  });
});

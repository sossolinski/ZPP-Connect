import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const coordinatorHeaders = { "content-type": "application/json", "x-user-email": "coordinator@lot.pl" };
const adminHeaders = { "content-type": "application/json", "x-user-email": "admin@lot.pl" };
const cleanupSessionIds: string[] = [];
const demoIds = {
  admin: "00000000-0000-4000-8000-000000000001",
  coordinator: "00000000-0000-4000-8000-000000000002",
  tec: "00000000-0000-4000-8000-000000000003",
  zpp: "00000000-0000-4000-8000-000000000004",
  volunteer: "00000000-0000-4000-8000-000000000005",
  viewer: "00000000-0000-4000-8000-000000000006"
};

type Row = Record<string, any>;

async function createSession(page: Page, token: string) {
  const response = await page.request.post(`${apiUrl}/sessions`, {
    headers: coordinatorHeaders,
    data: { mode: "EXERCISE", status: "Active", eventType: "Exercise", flightNumber: token, route: "WAW-S2C", description: "Isolated Stage 2C browser test session" }
  });
  expect(response.ok()).toBeTruthy();
  const session = await response.json() as Row;
  cleanupSessionIds.push(session.id);
  return session;
}

async function useSession(page: Page, session: Row) {
  await page.goto("/sessions");
  const row = page.getByRole("row").filter({ hasText: session.operationalId });
  await expect(row).toBeVisible();
  const button = row.getByRole("button", { name: "Use this session" });
  if (await button.count()) await button.click();
  await expect(page.locator(`[aria-label*="Current session EXERCISE ${session.operationalId}"]:visible`)).toHaveCount(1);
}

async function setSessionForRestrictedPersona(page: Page, session: Row) {
  await page.evaluate((sessionId) => localStorage.setItem("zpp:activeSessionId", sessionId), session.id);
  await page.reload();
  await expect(page.locator(`[aria-label*="Current session EXERCISE ${session.operationalId}"]:visible`)).toHaveCount(1);
}

async function createAssignment(page: Page, sessionId: string, title: string) {
  const response = await page.request.post(`${apiUrl}/assignments`, {
    headers: coordinatorHeaders,
    data: { sessionId, title, priority: "Urgent", details: `Operational detail for ${title}` }
  });
  expect(response.status()).toBe(201);
  return await response.json() as Row;
}

async function assign(page: Page, assignmentId: string, assignedUserId: string) {
  const response = await page.request.post(`${apiUrl}/assignments/${assignmentId}/assign`, { headers: coordinatorHeaders, data: { assignedUserId } });
  expect(response.ok()).toBeTruthy();
  return await response.json() as Row;
}

async function grantIncidentAccess(page: Page, sessionId: string, userIds: string[]) {
  for (const userId of userIds) {
    const response = await page.request.post(`${apiUrl}/sessions/${sessionId}/assignments`, {
      headers: adminHeaders,
      data: { userId, function: "Stage 2C role-boundary test" }
    });
    expect([201, 409]).toContain(response.status());
  }
}

test.afterEach(async ({ page }) => {
  for (const sessionId of cleanupSessionIds.splice(0)) {
    await page.request.post(`${apiUrl}/sessions/${sessionId}/close`, { headers: coordinatorHeaders, data: { notes: "Focused Stage 2C test cleanup." } }).catch(() => undefined);
  }
});

test("protects manual Timeline categories and exposes full provenance on desktop and mobile", async ({ page }) => {
  const token = `S2C-TL-${Date.now()}`;
  const session = await createSession(page, token);
  const assignment = await createAssignment(page, session.id, `${token}-SOURCE`);
  await assign(page, assignment.id, demoIds.coordinator);
  const started = await page.request.post(`${apiUrl}/assignments/${assignment.id}/status`, { headers: coordinatorHeaders, data: { status: "In Progress" } });
  expect(started.ok()).toBeTruthy();

  const rejected = await page.request.post(`${apiUrl}/timeline`, {
    headers: coordinatorHeaders,
    data: { sessionId: session.id, eventType: "verification", title: `${token}-FORGED`, body: "Not a real verification." }
  });
  expect(rejected.status()).toBe(400);

  await login(page);
  await useSession(page, session);
  await page.goto("/timeline");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const noteDrawer = page.getByRole("dialog", { name: "New Timeline Note" });
  const category = noteDrawer.getByLabel("Manual category");
  await expect(category.locator("option")).toHaveText(["General note", "Contact attempt", "Information received", "Operational update", "Handover note"]);
  for (const protectedType of ["Verification", "Rejection", "Hold", "Release", "Reunification", "Cancellation", "System"]) {
    await expect(category.getByRole("option", { name: protectedType, exact: true })).toHaveCount(0);
  }
  const longText = `Full Stage 2C handover text ${token}. This sentence must remain available without table clamping on both desktop and mobile layouts.`;
  await category.selectOption("handover_note");
  await noteDrawer.getByLabel("Title").fill(`${token}-NOTE`);
  await noteDrawer.getByLabel("Details").fill(longText);
  await noteDrawer.getByRole("button", { name: "Add note" }).click();

  const noteRow = page.getByRole("row").filter({ hasText: `${token}-NOTE` });
  await expect(noteRow).toContainText("Manual note");
  await expect(noteRow).toContainText("handover_note");
  await noteRow.getByRole("button", { name: "View timeline details" }).click();
  let detail = page.getByRole("dialog", { name: "Timeline event details" });
  await expect(detail.getByText(longText, { exact: true })).toBeVisible();
  await expect(detail.getByText("System Admin", { exact: true })).toBeVisible();
  await expect(detail.getByText("Timeline note endpoint", { exact: true })).toBeVisible();
  await expect(detail.getByText("manualNote", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Open source" })).toHaveCount(0);
  await detail.getByRole("button", { name: "Close" }).click();

  const workflowRow = page.getByRole("row").filter({ hasText: `Assignment ${assignment.operationalId} moved to In Progress` });
  await expect(workflowRow).toContainText("State transition");
  await workflowRow.getByRole("button", { name: "View timeline details" }).click();
  detail = page.getByRole("dialog", { name: "Timeline event details" });
  await expect(detail.getByText("Open", { exact: true }).first()).toBeVisible();
  await expect(detail.getByText("In Progress", { exact: true }).first()).toBeVisible();
  await detail.getByRole("button", { name: "Open source" }).click();
  await expect(page).toHaveURL(new RegExp(`/assignments\\?focus=${assignment.id}`));
  await expect(page.getByRole("dialog", { name: "Edit Assignment" })).toBeVisible();
  await page.getByRole("dialog", { name: "Edit Assignment" }).getByRole("button", { name: "Close" }).click();

  const historical = await page.request.get(`${apiUrl}/timeline?sessionId=ses-demo-1&limit=200`, { headers: coordinatorHeaders });
  const missingActor = ((await historical.json()).data as Row[]).find((item) => item.id === "tle-demo-1");
  expect(missingActor.createdBy).toBeNull();

  const notes = await page.request.get(`${apiUrl}/timeline?sessionId=${session.id}&limit=200`, { headers: coordinatorHeaders });
  const createdNote = ((await notes.json()).data as Row[]).find((item) => item.title === `${token}-NOTE`)!;
  expect((await page.request.patch(`${apiUrl}/timeline/${createdNote.id}`, { headers: coordinatorHeaders, data: { eventType: "release" } })).status()).toBe(404);
  expect((await page.request.delete(`${apiUrl}/timeline/${createdNote.id}`, { headers: coordinatorHeaders })).status()).toBe(404);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/timeline");
  await page.getByRole("row").filter({ hasText: `${token}-NOTE` }).getByRole("button", { name: "View timeline details" }).click();
  await expect(page.getByRole("dialog", { name: "Timeline event details" }).getByText(longText, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});

test("enforces assignment ownership workflow, conflicts, roles and mobile parity", async ({ page }) => {
  const token = `S2C-AS-${Date.now()}`;
  const session = await createSession(page, token);
  await grantIncidentAccess(page, session.id, [demoIds.zpp, demoIds.tec, demoIds.volunteer, demoIds.viewer]);
  const unassigned = await createAssignment(page, session.id, `${token}-UNASSIGNED`);
  const volunteerTask = await createAssignment(page, session.id, `${token}-VOLUNTEER`);
  await assign(page, volunteerTask.id, demoIds.volunteer);
  const coordinatorTask = await createAssignment(page, session.id, `${token}-REASSIGN`);
  await assign(page, coordinatorTask.id, demoIds.coordinator);
  const optionTask = await createAssignment(page, session.id, `${token}-OPTION`);
  await assign(page, optionTask.id, demoIds.volunteer);
  const terminal = await createAssignment(page, session.id, `${token}-TERMINAL`);
  await assign(page, terminal.id, demoIds.coordinator);
  await page.request.post(`${apiUrl}/assignments/${terminal.id}/status`, { headers: coordinatorHeaders, data: { status: "In Progress" } });
  await page.request.post(`${apiUrl}/assignments/${terminal.id}/status`, { headers: coordinatorHeaders, data: { status: "Completed" } });

  await login(page);
  await useSession(page, session);
  await page.goto("/assignments");
  const unassignedRow = page.getByRole("row").filter({ hasText: `${token}-UNASSIGNED` });
  const volunteerRow = page.getByRole("row").filter({ hasText: `${token}-VOLUNTEER` });
  const terminalRow = page.getByRole("row").filter({ hasText: `${token}-TERMINAL` });
  await expect(unassignedRow.getByRole("button", { name: "Claim", exact: true })).toBeVisible();
  await expect(volunteerRow.getByRole("button", { name: "Claim", exact: true })).toHaveCount(0);
  await expect(terminalRow.getByRole("button", { name: "View", exact: true })).toBeVisible();
  await expect(terminalRow.getByRole("button", { name: /Claim|Start|Complete|Reassign|Cancel/ })).toHaveCount(0);

  await unassignedRow.getByRole("button", { name: "Edit" }).click();
  const editDrawer = page.getByRole("dialog", { name: "Edit Assignment" });
  await expect(editDrawer.getByLabel("Status")).toHaveCount(0);
  await expect(editDrawer.getByLabel("Owner")).toHaveCount(0);
  await expect(editDrawer.getByText("Current status")).toBeVisible();
  await expect(editDrawer.getByText("Current assignee")).toBeVisible();
  await editDrawer.getByRole("button", { name: "Close" }).click();

  const externalClaim = await page.request.post(`${apiUrl}/assignments/${unassigned.id}/assign-to-me`, { headers: coordinatorHeaders, data: {} });
  expect(externalClaim.ok()).toBeTruthy();
  await unassignedRow.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page.getByText(/Another user claimed or changed this assignment/)).toBeVisible();
  await expect(unassignedRow).toContainText("Unassigned");

  const reassignRow = page.getByRole("row").filter({ hasText: `${token}-REASSIGN` });
  await reassignRow.getByRole("button", { name: "Reassign" }).click();
  const reassignDialog = page.getByRole("dialog", { name: "Reassign work" });
  await reassignDialog.getByRole("button", { name: "Confirm reassignment" }).click();
  await expect(reassignDialog.getByText("Select a new assignee and enter a handover reason.")).toBeVisible();
  await reassignDialog.getByLabel("New assignee").selectOption({ label: "ZPP Member 01" });
  await reassignDialog.getByLabel("Handover reason").fill("Coordinator-approved handover for the next operational shift.");
  await reassignDialog.getByRole("button", { name: "Confirm reassignment" }).click();
  await expect(page.getByText(new RegExp(`${coordinatorTask.operationalId} reassigned to ZPP Member 01`))).toBeVisible();

  const audit = await page.request.get(`${apiUrl}/audit-logs?sessionId=${session.id}&limit=200`, { headers: adminHeaders });
  const reassignment = ((await audit.json()).data as Row[]).find((item) => item.action === "reassign_assignment" && item.entityId === coordinatorTask.id);
  expect(reassignment.metadata).toMatchObject({
    previousAssigneeId: demoIds.coordinator,
    previousAssigneeDisplayName: "ZPP Coordinator",
    newAssigneeId: demoIds.volunteer,
    newAssigneeDisplayName: "ZPP Member 01",
    reason: "Coordinator-approved handover for the next operational shift."
  });

  await login(page, "coordinator@lot.pl");
  await setSessionForRestrictedPersona(page, session);
  await page.goto("/assignments");
  await expect(page.getByRole("button", { name: "Reassign" }).first()).toBeVisible();

  await login(page, "zpp@lot.pl");
  await setSessionForRestrictedPersona(page, session);
  await page.goto("/assignments");
  await expect(page.getByRole("main")).not.toContainText(token);
  await expect(page.getByRole("button", { name: "Reassign" })).toHaveCount(0);

  await login(page, "tec@lot.pl");
  await setSessionForRestrictedPersona(page, session);
  await page.goto("/assignments");
  await expect(page.getByText(/My active assignments - filtered to TEC Member/)).toBeVisible();
  await expect(page.getByLabel("Owner filter")).toHaveValue("__mine__");
  await expect(page.getByRole("button", { name: /Claim|Assign|Reassign|Start|Complete|Cancel/ })).toHaveCount(0);

  await login(page, "volunteer@lot.pl");
  await setSessionForRestrictedPersona(page, session);
  await page.goto("/assignments");
  await expect(page.getByText(/My active assignments - filtered to ZPP Member 01/)).toBeVisible();
  await expect(page.getByLabel("Owner filter")).toHaveValue("__mine__");
  await expect(page.getByRole("row").filter({ hasText: `${token}-VOLUNTEER` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reassign" })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("row").filter({ hasText: `${token}-VOLUNTEER` }).getByRole("button", { name: "Start" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);

  await login(page, "viewer@lot.pl");
  await setSessionForRestrictedPersona(page, session);
  await page.goto("/assignments");
  await expect(page.getByRole("heading", { name: "Limited Access" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Claim|Assign|Reassign|Start|Complete|Cancel/ })).toHaveCount(0);
});

test("blocks a stale assignment drawer after the session closes and keeps Audit read-only", async ({ page }) => {
  const token = `S2C-STALE-${Date.now()}`;
  const session = await createSession(page, token);
  const assignment = await createAssignment(page, session.id, `${token}-TASK`);
  await assign(page, assignment.id, demoIds.admin);

  await login(page);
  await useSession(page, session);
  await page.goto("/audit");
  const row = page.getByRole("row").filter({ hasText: `${assignment.operationalId} assigned to System Admin` });
  await row.getByRole("button", { name: "View audit details" }).click();
  const auditDetail = page.getByRole("dialog", { name: "Audit event details" });
  await expect(auditDetail.getByText("Assignment activity", { exact: true }).first()).toBeVisible();
  await expect(auditDetail.getByText("System Admin", { exact: true }).first()).toBeVisible();
  await expect(auditDetail.getByRole("button", { name: "Open source" })).toBeVisible();
  await auditDetail.getByRole("button", { name: "Close" }).click();

  await page.goto("/assignments");
  await page.getByRole("row").filter({ hasText: `${token}-TASK` }).getByRole("button", { name: "Edit" }).click();
  const drawer = page.getByRole("dialog", { name: "Edit Assignment" });
  await drawer.getByLabel("Title").fill(`${token}-UNSAVED`);
  const closed = await page.request.post(`${apiUrl}/sessions/${session.id}/close`, { headers: coordinatorHeaders, data: { notes: "Close while the Stage 2C assignment drawer is open." } });
  expect(closed.ok()).toBeTruthy();
  cleanupSessionIds.splice(cleanupSessionIds.indexOf(session.id), 1);
  await drawer.getByRole("button", { name: "Save changes" }).click();
  await expect(drawer.getByText(/session changed or is no longer writable/i)).toBeVisible();

  const stored = await page.request.get(`${apiUrl}/assignments?sessionId=${session.id}&limit=200`, { headers: coordinatorHeaders });
  expect(((await stored.json()).data as Row[]).find((item) => item.id === assignment.id)?.title).toBe(`${token}-TASK`);

  const logs = await page.request.get(`${apiUrl}/audit-logs?sessionId=${session.id}&limit=200`, { headers: adminHeaders });
  const log = ((await logs.json()).data as Row[])[0];
  expect((await page.request.patch(`${apiUrl}/audit-logs/${log.id}`, { headers: adminHeaders, data: { actorEmail: "forged@example.test" } })).status()).toBe(404);
  expect((await page.request.delete(`${apiUrl}/audit-logs/${log.id}`, { headers: adminHeaders })).status()).toBe(404);
});

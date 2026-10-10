import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { login } from "./helpers";

const db = new PrismaClient(), marker = `PI2-BROWSER-${randomUUID().slice(0, 8)}`;
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4100}/api`;
let activeId: string, emptyId: string, briefingTitle: string, groupId: string, memberId: string, shiftId: string, noteId: string, urgentId: string;
const tasks: Record<string, string> = {};
async function openWorkspace(page: Page, email: string, incident?: string) {
  await login(page, email);
  await expect(page.getByTestId("dashboard-freshness")).toContainText("Data loaded successfully");
  await page.evaluate(id => localStorage.setItem("zpp:activeSessionId", id), incident ?? activeId);
  await page.goto("/dashboard");
  await expect(page.getByTestId("dashboard-freshness")).toContainText("Data loaded successfully");
}
test.beforeAll(async () => {
  expect(process.env.PLAYWRIGHT_PERSISTENCE_MODE).toBe("postgres");
  activeId = (await db.session.findUniqueOrThrow({ where: { operationalId: "SES-2026-001" } })).id;
  briefingTitle = (await db.operationalBriefing.findFirstOrThrow({ where: { sessionId: activeId, status: "Published" } })).title;
  const coordinator = await db.user.findUniqueOrThrow({ where: { email: "coordinator@lot.pl" } });
  const leader = await db.user.findUniqueOrThrow({ where: { email: "zpp@lot.pl" } });
  const member = await db.user.findUniqueOrThrow({ where: { email: "volunteer@lot.pl" } });
  groupId = (await db.groupRoleAssignment.findFirstOrThrow({ where: { userId: leader.id, status: "Active", group: { incidentId: activeId } } })).groupId;
  memberId = (await db.memberProfile.findUniqueOrThrow({ where: { linkedUserId: member.id } })).id;
  await db.groupMembership.createMany({ skipDuplicates: true, data: { id: `${marker}-membership`, groupId, memberProfileId: memberId } });
  for (const email of ["coordinator@lot.pl", "tec@lot.pl", "zpp@lot.pl", "volunteer@lot.pl"]) {
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    tasks[email] = (await db.assignmentTask.create({ data: { operationalId: `${marker}-${email.split("@")[0]}`, sessionId: activeId, title: `${marker} ${email} responsibility`, assignedUserId: user.id, priority: "Urgent", status: "Escalated", dueAt: new Date("1990-01-01T00:00:00Z") } })).id;
  }
  urgentId = (await db.request.create({ data: { operationalId: `${marker}-URGENT`, incidentId: activeId, category: "Transport", details: "PI2 support follow-up", status: "WAITING", priority: "Urgent", ownerUserId: coordinator.id, dueAt: new Date("1990-01-01T00:00:00Z") } })).id;
  const current = Date.now();
  shiftId = `${marker}-SHIFT`;
  await db.rosterShift.create({ data: { id: shiftId, operationalId: `${marker}-ROS`, sessionId: activeId, groupId, assignedMemberProfileId: memberId, title: `${marker} current coverage`, duty: "Support", functionName: "Family Assistance", location: "Synthetic assistance desk", startAt: new Date(current - 86_400_000), endAt: new Date(current + 86_400_000), status: "Confirmed" } });
  await db.rosterShift.create({ data: { id: `${marker}-FUTURE`, operationalId: `${marker}-FUTURE-ROS`, sessionId: activeId, groupId, assignedMemberProfileId: memberId, title: `${marker} future shift`, duty: "Support", functionName: "Future duty", location: "Synthetic desk", startAt: new Date(current + 172_800_000), endAt: new Date(current + 259_200_000), status: "Confirmed" } });
  noteId = (await db.caseTimelineEvent.create({ data: { sessionId: activeId, eventType: "note", title: `${marker} handover update`, body: "Replacement operator should review the unresolved transport support.", createdById: coordinator.id } })).id;
  emptyId = (await db.session.create({ data: { operationalId: `${marker}-EMPTY`, mode: "REAL", status: "Draft", eventType: "PI2 empty personal work", description: "Synthetic no-work acceptance incident" } })).id;
  await db.incidentAssignment.create({ data: { incidentId: emptyId, userId: member.id, function: "Member", createdById: coordinator.id } });
});
test.afterAll(async () => { await db.$disconnect(); });

for (const email of ["coordinator@lot.pl", "tec@lot.pl", "zpp@lot.pl", "volunteer@lot.pl"]) test(`operator journey workspace → briefing → attention record → workspace for ${email}`, async ({ page }) => {
  await openWorkspace(page, email);
  await expect(page.getByTestId("workspace-incident")).toContainText("SES-2026-001");
  await expect(page.getByTestId("workspace-briefing")).toContainText(briefingTitle);
  await expect(page.getByTestId("workspace-my-work")).toContainText(`${marker} ${email} responsibility`);
  await expect(page.getByTestId("workspace-my-work")).toContainText("Overdue");
  if (email === "zpp@lot.pl") {
    await expect(page.getByTestId("workspace-team-work")).toContainText("Family Assistance Alpha");
    await expect(page.getByTestId("workspace-team-work")).toContainText(`${marker} volunteer@lot.pl responsibility`);
    await expect(page.getByTestId("workspace-team-work")).not.toContainText("Support request");
  }
  if (email === "tec@lot.pl") {
    await expect(page.getByTestId("dashboard-metrics")).toContainText("Not available for your role");
    await expect(page.getByTestId("dashboard-attention")).toContainText(`${marker}-URGENT`);
  }
  await page.getByRole("link", { name: "Read full briefing", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Operational Briefing", exact: true })).toBeVisible();
  await expect(page.getByTestId("briefing-freshness")).toContainText("Published");
  await page.getByRole("link", { name: "Incident Workspace", exact: true }).click();
  const href = email === "tec@lot.pl" ? `/requests?requestId=${urgentId}` : `/assignments?assignmentId=${tasks[email]}`;
  const attention = page.getByTestId("dashboard-attention").locator(`a[href="${href}"]`);
  await attention.focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(email === "tec@lot.pl" ? /\/requests\?requestId=/ : /\/assignments\?assignmentId=/);
  const dialog = page.getByRole("dialog");
  if (email === "tec@lot.pl") await expect(dialog).toContainText(`${marker}-URGENT`);
  else await expect(dialog.getByLabel("Title")).toHaveValue(`${marker} ${email} responsibility`);
  await page.getByRole("dialog").getByRole("button", { name: /Close/i }).first().click();
  await page.getByRole("link", { name: "Incident Workspace", exact: true }).click();
  await expect(page.getByTestId("workspace-my-work")).toContainText(`${marker} ${email} responsibility`);
});

test("observer sees authority and context with no actionable work or false zeroes", async ({ page }) => {
  await openWorkspace(page, "viewer@lot.pl");
  await expect(page.getByTestId("workspace-briefing")).toContainText(briefingTitle);
  await expect(page.getByTestId("workspace-my-work")).toHaveCount(0);
  await expect(page.getByTestId("workspace-team-work")).toHaveCount(0);
  await expect(page.getByTestId("dashboard-attention").getByRole("link")).toHaveCount(0);
  await expect(page.getByText("Manifest coverage", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("dashboard-attention")).toContainText("unavailable");
});

test("handover and contextual help support keyboard reading without lifecycle commands", async ({ page }) => {
  await openWorkspace(page, "coordinator@lot.pl");
  await page.getByRole("button", { name: "Read handover" }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Return to workspace" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("workspace-handover")).toContainText("Incident handover");
  await expect(page.getByTestId("workspace-briefing")).toContainText("Update overdue");
  await expect(page.getByTestId("workspace-team-work")).toContainText("Waiting — follow-up needed");
  await expect(page.getByTestId("incident-workspace").getByRole("button", { name: /Assign|Complete|Resolve|Publish/ })).toHaveCount(0);
  const attentionList = page.getByRole("list", { name: "Permitted attention items" });
  await attentionList.focus(); await page.keyboard.press("PageDown");
  await expect.poll(() => attentionList.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const help = page.locator("summary").filter({ hasText: "Getting-started help and terms" });
  await help.focus(); await page.keyboard.press("Enter"); await expect(page.getByText("TEC: telephone enquiry centre", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Return to workspace" }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("workspace-handover")).toHaveCount(0);
});

test("staffing uses the current period and opens the exact shift; activity opens the Timeline entry", async ({ page }) => {
  await openWorkspace(page, "coordinator@lot.pl");
  const staffing = page.getByTestId("workspace-coverage");
  await expect(staffing).toContainText(`${marker} current coverage`); await expect(staffing).toContainText("Confirmed coverage");
  await expect(staffing).not.toContainText(`${marker} future shift`);
  await staffing.locator(`a[href="/rostering?shiftId=${shiftId}"]`).click();
  await expect(page.getByRole("dialog")).toContainText(`${marker} current coverage`);
  await page.getByRole("dialog").getByRole("button", { name: /Close/i }).first().click();
  await page.getByRole("link", { name: "Incident Workspace", exact: true }).click();
  await expect(page.getByTestId("workspace-activity")).toContainText(`${marker} handover update`);
  await page.getByTestId("workspace-activity").locator(`a[href="/timeline?eventId=${noteId}"]`).click();
  await expect(page.getByRole("dialog")).toContainText(`${marker} handover update`);
});

test("leader sees reassignment-needed work after a group assignee loses incident access", async ({ page }) => {
  const member = await db.user.findUniqueOrThrow({ where: { email: "volunteer@lot.pl" } });
  const membership = await db.incidentAssignment.findFirstOrThrow({ where: { incidentId: activeId, userId: member.id, active: true } });
  await db.incidentAssignment.update({ where: { id: membership.id }, data: { active: false } });
  try {
    await openWorkspace(page, "zpp@lot.pl");
    const item = page.getByTestId("workspace-team-work").locator(`a[href="/assignments?assignmentId=${tasks["volunteer@lot.pl"]}"]`);
    await expect(item).toContainText("Reassignment required");
    await expect(item).toContainText(`${marker} volunteer@lot.pl responsibility`);
  } finally { await db.incidentAssignment.update({ where: { id: membership.id }, data: { active: true } }); }
});

test("personal empty differs from unavailable and unpublished authority", async ({ page }) => {
  await openWorkspace(page, "volunteer@lot.pl", emptyId);
  await expect(page.getByTestId("workspace-my-work")).toContainText("No open work in this scope");
  await expect(page.getByTestId("workspace-briefing")).toContainText("No published briefing");
  await expect(page.getByTestId("workspace-team-work")).toHaveCount(0);
});

test("stale handover, failed refresh and retry preserve a truthful snapshot", async ({ page }) => {
  await page.clock.install({ time: new Date() }); await openWorkspace(page, "coordinator@lot.pl");
  await page.getByRole("button", { name: "Read handover" }).click(); await page.clock.fastForward(301_000);
  await expect(page.getByTestId("workspace-handover")).toContainText("Snapshot may be stale");
  await page.route("**/api/dashboard?*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "PI2 acceptance unavailable" }) }));
  await page.getByRole("button", { name: "Refresh dashboard" }).click();
  await expect(page.getByTestId("dashboard-freshness")).toContainText("Refresh failed — showing previously loaded data");
  await expect(page.getByTestId("workspace-briefing")).toContainText(briefingTitle);
  await expect(page.getByTestId("workspace-my-work")).toContainText(marker);
  await page.unroute("**/api/dashboard?*"); await page.clock.setSystemTime(new Date()); await page.clock.runFor(15_000);
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await expect(page.getByTestId("dashboard-freshness")).toContainText("Data loaded successfully");
});

test("initial failure and no active incident remain distinct", async ({ page }) => {
  await openWorkspace(page, "tec@lot.pl");
  await page.route("**/api/dashboard?*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) }));
  await page.goto("/dashboard"); await expect(page.getByText("Dashboard unavailable", { exact: true })).toBeVisible(); await expect(page.getByTestId("workspace-my-work")).toHaveCount(0);
  await page.unroute("**/api/dashboard?*");
  await page.route("**/api/sessions?*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 0, data: [] }) }));
  await page.goto("/dashboard"); await expect(page.getByText("No active incident", { exact: true })).toBeVisible();
});

for (const width of [1440, 1280, 1024, 768]) test(`workspace stays useful without page overflow at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await openWorkspace(page, "coordinator@lot.pl");
  await expect(page.getByTestId("workspace-incident")).toBeVisible(); await expect(page.getByTestId("workspace-briefing")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.getByTestId("workspace-briefing").boundingBox().then(box => box!.y)).toBeLessThan(600);
  await page.screenshot({ path: `storage/local-preview/pi2-workspace-${width}.png`, fullPage: true });
});

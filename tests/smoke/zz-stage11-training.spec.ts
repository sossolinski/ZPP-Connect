import { expect, test, type Page, type Route } from "@playwright/test";
import { login } from "./helpers";

test.setTimeout(60_000);

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

const member = { id: "mem-stage11-1", memberId: "ZPP-1101", displayName: "Stage Eleven Member", pool: "ZPP", role: "Member", assignedFunction: "Family Assistance Team", status: "Active" };
const secondMember = { ...member, id: "mem-stage11-2", memberId: "ZPP-1102", displayName: "Lookup Target" };
const group = { id: "grp-stage11-1", operationalId: "GRP-1101", name: "Stage Eleven Group", functionName: "Family Assistance Team", status: "Active", memberCount: 3 };
const activeCourse = { id: "crs-stage11-1", code: "ST11-CORE", title: "Stage 11 Core", description: "Controlled training", category: "Core", deliveryType: "E-learning", validityMonths: 12, active: true, selfCompletable: true, version: 7, updatedAt: "2026-08-10T09:00:00.000Z" };
const inactiveCourse = { ...activeCourse, id: "crs-stage11-2", code: "ST11-HISTORY", title: "Stage 11 Historical", active: false, version: 4 };
const requirement = { id: "trq-stage11-1", courseId: activeCourse.id, course: activeCourse, targetType: "Group", groupId: group.id, target: { label: group.name }, requiredStatus: "Required", dueAt: "2026-08-01T09:00:00.000Z", active: true, resolvedMemberCount: 3, version: 5, updatedAt: "2026-08-10T09:00:00.000Z" };

function trainingRecord(values: Record<string, unknown>) {
  return {
    id: "trn-stage11-assigned",
    operationalId: "TRN-1101",
    memberProfileId: member.id,
    member,
    courseId: activeCourse.id,
    course: activeCourse,
    sourceRequirement: { id: requirement.id, targetType: "Group", targetLabel: group.name, requiredStatus: "Required" },
    assignedAt: "2026-07-01T09:00:00.000Z",
    dueAt: "2026-07-10T09:00:00.000Z",
    status: "Assigned",
    baseStatus: "Assigned",
    isOverdue: true,
    isExpiringSoon: false,
    completedAt: null,
    expiryAt: null,
    verifiedAt: null,
    verifiedById: null,
    verifiedBy: null,
    verificationStatus: "Not applicable",
    version: 3,
    updatedAt: "2026-08-10T09:00:00.000Z",
    permissions: { canStart: true, canComplete: true, canVerify: false, canWaive: true, canCancel: true, canEdit: true },
    ...values,
  };
}

async function routeLookups(page: Page, memberUrls: URL[] = [], groupUrls: URL[] = []) {
  await page.route("**/api/member-profiles**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/api/member-profiles") {
      memberUrls.push(url);
      await json(route, 200, { total: 2, limit: Number(url.searchParams.get("limit") ?? 50), offset: 0, data: [member, secondMember] });
    } else await route.continue();
  });
  await page.route("**/api/groups**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/api/groups") {
      groupUrls.push(url);
      await json(route, 200, { total: 1, limit: Number(url.searchParams.get("limit") ?? 50), offset: 0, data: [group] });
    } else await route.continue();
  });
}

test("uses bounded Training queues, server totals, filters and explicit versioned commands", async ({ page }) => {
  const recordGets: URL[] = [];
  const commands = new Map<string, Record<string, unknown>>();
  const pending = trainingRecord({ id: "trn-stage11-pending", operationalId: "TRN-1102", status: "Completed", baseStatus: "Completed", isOverdue: false, completedAt: "2026-07-12T09:00:00.000Z", expiryAt: "2027-07-12T09:00:00.000Z", verificationStatus: "Pending", version: 8, permissions: { canVerify: true } });
  const verified = trainingRecord({ id: "trn-stage11-verified", operationalId: "TRN-1103", status: "Completed", baseStatus: "Completed", isOverdue: false, completedAt: "2026-07-11T09:00:00.000Z", expiryAt: "2027-07-11T09:00:00.000Z", verificationStatus: "Verified", verifiedAt: "2026-07-12T10:00:00.000Z", verifiedById: "usr-verifier", verifiedBy: { id: "usr-verifier", email: "verifier@example.test", displayName: "Verification Officer" }, version: 9, permissions: {} });
  const expiring = trainingRecord({ id: "trn-stage11-expiring", operationalId: "TRN-1104", status: "Completed", baseStatus: "Completed", isOverdue: false, isExpiringSoon: true, completedAt: "2025-09-01T09:00:00.000Z", expiryAt: "2026-09-01T09:00:00.000Z", verificationStatus: "Pending", version: 2, permissions: { canVerify: true } });
  const expired = trainingRecord({ id: "trn-stage11-expired", operationalId: "TRN-1105", status: "Expired", baseStatus: "Completed", isOverdue: false, completedAt: "2024-01-01T09:00:00.000Z", expiryAt: "2025-01-01T09:00:00.000Z", verificationStatus: "Verified", verifiedAt: "2024-01-02T09:00:00.000Z", verifiedById: "usr-verifier", verifiedBy: { id: "usr-verifier", email: "verifier@example.test", displayName: "Verification Officer" }, version: 4, permissions: {} });
  const assigned = trainingRecord({});

  await routeLookups(page);
  await page.route("**/api/training/courses**", async (route) => {
    if (route.request().method() === "GET") await json(route, 200, { total: 77, limit: 50, offset: Number(new URL(route.request().url()).searchParams.get("offset") ?? 0), data: [activeCourse, inactiveCourse] });
    else await route.continue();
  });
  await page.route("**/api/training/requirements**", async (route) => {
    if (route.request().method() === "GET") await json(route, 200, { total: 66, limit: 50, offset: 0, data: [requirement] });
    else await route.continue();
  });
  await page.route("**/api/training/records**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/training/records") {
      recordGets.push(url);
      await json(route, 200, { total: 123, limit: Number(url.searchParams.get("limit")), offset: Number(url.searchParams.get("offset")), data: [assigned, pending, verified, expiring, expired], totals: { assigned: 42, inProgress: 57, completed: 18, expired: 4, waived: 1, cancelled: 1, overdue: 13, expiringSoon: 6 } });
      return;
    }
    if (request.method() === "POST") {
      const action = url.pathname.split("/").at(-1)!;
      commands.set(`${url.pathname}:${action}`, request.postDataJSON());
      if (action === "start") {
        await json(route, 409, { error: "This training record changed. Refresh and compare before trying again" });
        return;
      }
      await json(route, 200, { ...(url.pathname.includes(pending.id) ? pending : assigned), version: 9, permissions: {} });
      return;
    }
    await route.continue();
  });

  await login(page, "admin@lot.pl");
  await page.goto("/training");
  await expect(page.getByText("99")).toBeVisible();
  await expect(page.getByText("Verification pending").first()).toBeVisible();
  await expect(page.getByText("Verified by Verification Officer").first()).toBeVisible();
  await expect(page.getByText("Expiring soon").first()).toBeVisible();
  await expect(page.locator("table").getByText("Expired", { exact: true })).toBeVisible();
  expect(recordGets[0]?.searchParams.get("limit")).toBe("50");
  expect(recordGets[0]?.searchParams.get("offset")).toBe("0");

  await page.getByLabel("Status").selectOption("Expired");
  await expect.poll(() => recordGets.some((url) => url.searchParams.get("status") === "Expired")).toBe(true);
  await page.getByLabel("Queue").selectOption("Overdue");
  await expect.poll(() => recordGets.some((url) => url.searchParams.get("overdue") === "true")).toBe(true);
  await page.getByRole("button", { name: "Next" }).first().click();
  await expect.poll(() => recordGets.some((url) => url.searchParams.get("offset") === "50")).toBe(true);

  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText("This training record changed. Refresh and compare before trying again")).toBeVisible();
  await page.getByRole("button", { name: "Verify" }).first().click();
  await expect.poll(() => [...commands.keys()].some((key) => key.includes("verify"))).toBe(true);

  await page.getByRole("button", { name: "Complete" }).click();
  const completeDialog = page.getByRole("dialog", { name: "Record completion" });
  await completeDialog.getByRole("button", { name: "Record completion" }).click();
  await page.getByRole("button", { name: "Waive" }).click();
  let reasonDialog = page.getByRole("dialog", { name: "Waive training" });
  await reasonDialog.getByLabel("Reason").fill("Equivalent qualification accepted");
  await reasonDialog.getByRole("button", { name: "Waive training" }).click();
  await expect(reasonDialog).toBeHidden();
  await page.getByRole("button", { name: "Cancel" }).first().click();
  reasonDialog = page.getByRole("dialog", { name: "Cancel training" });
  await reasonDialog.getByLabel("Reason").fill("Assignment no longer required");
  await reasonDialog.getByRole("button", { name: "Cancel training" }).click();

  for (const action of ["verify", "complete", "waive", "cancel"]) {
    const payload = [...commands.entries()].find(([key]) => key.endsWith(`:${action}`))?.[1];
    expect(typeof payload?.expectedVersion).toBe("number");
    expect(String(payload?.operationId)).toMatch(/^[0-9a-f-]{36}$/i);
  }
});

test("manages course and requirement lifecycles and uses bounded Member/Group lookups for assignment", async ({ page }) => {
  const memberUrls: URL[] = [];
  const groupUrls: URL[] = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  await routeLookups(page, memberUrls, groupUrls);
  await page.route("**/api/training/records**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") await json(route, 200, { total: 0, limit: 50, offset: 0, data: [], totals: { assigned: 0, inProgress: 0, completed: 0, expired: 0, waived: 0, cancelled: 0, overdue: 0, expiringSoon: 0 } });
    else if (request.method() === "POST" && url.pathname === "/api/training/records/assign") {
      const body = request.postDataJSON();
      writes.push({ path: url.pathname, body });
      await json(route, 201, body.groupId ? { targetType: "Group", group, course: activeCourse, assignedCount: 2, skippedCount: 1, records: [] } : trainingRecord({ id: "trn-created" }));
    } else await route.continue();
  });
  await page.route("**/api/training/courses**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") await json(route, 200, { total: 2, limit: 50, offset: 0, data: [activeCourse, inactiveCourse] });
    else {
      const body = request.postDataJSON() ?? {};
      writes.push({ path: url.pathname, body });
      await json(route, request.method() === "POST" && url.pathname === "/api/training/courses" ? 201 : 200, { ...activeCourse, ...body, active: url.pathname.endsWith("reactivate") ? true : url.pathname.endsWith("deactivate") ? false : activeCourse.active, version: activeCourse.version + 1 });
    }
  });
  await page.route("**/api/training/requirements**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") await json(route, 200, { total: 1, limit: 50, offset: 0, data: [requirement] });
    else {
      const body = request.postDataJSON() ?? {};
      writes.push({ path: url.pathname, body });
      await json(route, url.pathname === "/api/training/requirements" ? 201 : 200, { ...requirement, ...body, active: !url.pathname.endsWith("end"), version: requirement.version + 1 });
    }
  });

  await login(page, "admin@lot.pl");
  await page.goto("/training");

  await page.getByRole("button", { name: "New course" }).click();
  const createCourse = page.getByRole("dialog", { name: "New course" });
  await expect(createCourse.getByLabel("Code")).toBeFocused();
  await createCourse.getByLabel("Code").fill("ST11-NEW");
  await createCourse.getByLabel("Title").fill("Stage 11 New Course");
  await createCourse.getByRole("button", { name: "Save course" }).click();
  expect(writes.find(({ path }) => path === "/api/training/courses")?.body).toMatchObject({ code: "ST11-NEW", title: "Stage 11 New Course" });

  await page.getByRole("row", { name: /ST11-CORE/ }).getByRole("button", { name: "Edit" }).click();
  let courseDialog = page.getByRole("dialog", { name: "Edit course" });
  await courseDialog.getByLabel("Title").fill("Stage 11 Core updated");
  await courseDialog.getByRole("button", { name: "Save course" }).click();
  expect(writes.find(({ path }) => path === `/api/training/courses/${activeCourse.id}`)?.body.expectedVersion).toBe(7);
  await page.getByRole("row", { name: /ST11-CORE/ }).getByRole("button", { name: "Edit" }).click();
  courseDialog = page.getByRole("dialog", { name: "Edit course" });
  await courseDialog.getByRole("button", { name: "Deactivate course" }).click();
  expect(writes.find(({ path }) => path.endsWith("/deactivate"))?.body).toEqual({ expectedVersion: 7 });
  await page.getByRole("row", { name: /ST11-HISTORY/ }).getByRole("button", { name: "Edit" }).click();
  courseDialog = page.getByRole("dialog", { name: "Edit course" });
  await courseDialog.getByRole("button", { name: "Reactivate course" }).click();
  expect(writes.find(({ path }) => path.endsWith("/reactivate"))?.body).toEqual({ expectedVersion: 4 });

  await page.getByRole("button", { name: "New requirement" }).click();
  let requirementDialog = page.getByRole("dialog", { name: "New requirement" });
  await requirementDialog.getByLabel("Target type").selectOption("MemberProfile");
  await requirementDialog.getByLabel("Find member").fill("Lookup Target");
  await expect.poll(() => memberUrls.some((url) => url.searchParams.get("search") === "Lookup Target" && url.searchParams.get("limit") === "50")).toBe(true);
  await requirementDialog.getByRole("combobox", { name: /^Member/ }).selectOption(secondMember.id);
  await requirementDialog.getByRole("button", { name: "Save requirement" }).click();
  await page.getByRole("row", { name: new RegExp(group.name) }).getByRole("button", { name: "Edit" }).click();
  requirementDialog = page.getByRole("dialog", { name: "Edit requirement" });
  await requirementDialog.getByLabel("Requirement status").selectOption("Recommended");
  await requirementDialog.getByRole("button", { name: "Save requirement" }).click();
  expect(writes.find(({ path }) => path === `/api/training/requirements/${requirement.id}`)?.body.expectedVersion).toBe(5);
  await page.getByRole("row", { name: new RegExp(group.name) }).getByRole("button", { name: "Edit" }).click();
  requirementDialog = page.getByRole("dialog", { name: "Edit requirement" });
  await requirementDialog.getByRole("button", { name: "End requirement" }).click();
  expect(writes.find(({ path }) => path.endsWith("/end"))?.body).toEqual({ expectedVersion: 5 });

  await page.getByRole("button", { name: "Assign training" }).click();
  let assignDialog = page.getByRole("dialog", { name: "Assign training" });
  await assignDialog.getByLabel("Find member").fill("Lookup Target");
  await expect.poll(() => memberUrls.filter((url) => url.searchParams.get("search") === "Lookup Target").length).toBeGreaterThan(1);
  await assignDialog.getByRole("combobox", { name: /^Member/ }).selectOption(secondMember.id);
  await assignDialog.getByRole("button", { name: "Assign training" }).click();
  await page.getByRole("button", { name: "Assign training" }).click();
  assignDialog = page.getByRole("dialog", { name: "Assign training" });
  await assignDialog.getByLabel("Assign to").selectOption("Group");
  await assignDialog.getByLabel("Find group").fill("Stage Eleven");
  await expect.poll(() => groupUrls.some((url) => url.searchParams.get("search") === "Stage Eleven" && url.searchParams.get("limit") === "50")).toBe(true);
  await assignDialog.getByRole("combobox", { name: /^Group/ }).selectOption(group.id);
  await assignDialog.getByRole("button", { name: "Assign training" }).click();
  await expect(page.getByText("Training assigned to 2 group members; 1 already had it")).toBeVisible();

  const assignments = writes.filter(({ path }) => path === "/api/training/records/assign");
  expect(assignments[0]?.body).toMatchObject({ memberProfileId: secondMember.id, courseId: activeCourse.id });
  expect(assignments[1]?.body).toMatchObject({ groupId: group.id, courseId: activeCourse.id });
  expect(String(assignments[0]?.body.operationId)).toMatch(/^[0-9a-f-]{36}$/i);
  expect(String(assignments[1]?.body.operationId)).toMatch(/^[0-9a-f-]{36}$/i);
});

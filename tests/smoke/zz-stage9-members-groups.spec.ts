import { expect, test, type Route } from "@playwright/test";
import { login } from "./helpers";

const member = (id: string, memberId: string, firstName: string, lastName: string, version = 1) => ({
  id,
  memberId,
  volunteerId: memberId,
  firstName,
  lastName,
  displayName: `${firstName} ${lastName}`,
  pool: "ZPP",
  role: "Member",
  assignedFunction: "Welfare Support",
  contactEmail: `${firstName.toLowerCase()}@example.test`,
  phone: "+48 600 000 001",
  languages: ["PL"],
  status: "Active",
  version,
  availability: "Managed in Availability",
  trainingStatus: "Managed in Training",
  rosterStatus: "Managed in Rostering",
  assignedLeader: null,
});

const alpha = member("mem-stage9-a", "ZPP-901", "Alpha", "Member", 7);
const bravo = member("mem-stage9-b", "ZPP-902", "Bravo", "Member", 4);

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

test.describe("Foundation Stage 9 Member and Group UX", () => {
  test("uses bounded server pagination/search and keeps stale member edits unsaved", async ({ page }) => {
    const memberGets: URL[] = [];
    let updatePayload: Record<string, unknown> | undefined;
    let createPayload: Record<string, unknown> | undefined;
    let archivePayload: Record<string, unknown> | undefined;
    await page.route("**/api/member-profiles**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "PATCH") {
        updatePayload = request.postDataJSON();
        await json(route, 409, { error: "This record changed while you were reviewing it. Refresh and try again" });
        return;
      }
      if (request.method() === "POST" && url.pathname === "/api/member-profiles") {
        createPayload = request.postDataJSON();
        await json(route, 201, { ...alpha, ...createPayload, id: "mem-stage9-created", memberId: "ZPP-903", volunteerId: "ZPP-903", version: 1 });
        return;
      }
      if (request.method() === "POST" && url.pathname.endsWith("/archive")) {
        archivePayload = request.postDataJSON();
        await json(route, 200, { ...alpha, status: "Archived", version: 8 });
        return;
      }
      if (request.method() !== "GET" || url.pathname !== "/api/member-profiles") {
        await route.continue();
        return;
      }
      memberGets.push(url);
      const search = url.searchParams.get("search")?.toLowerCase() ?? "";
      const data = search.includes("bravo") ? [bravo] : [alpha];
      await json(route, 200, { total: search ? 1 : 60, limit: Number(url.searchParams.get("limit")), offset: Number(url.searchParams.get("offset")), data });
    });

    await login(page, "admin@lot.pl");
    await page.goto("/members");
    await expect(page.getByText("Alpha Member").first()).toBeVisible();
    await expect(page.getByText("alpha@example.test").first()).toBeVisible();
    await expect(page.getByText("1-1 of 60")).toBeVisible();

    await page.getByRole("button", { name: "Next" }).click();
    await expect.poll(() => memberGets.some((url) => url.searchParams.get("offset") === "25")).toBe(true);
    await page.getByRole("button", { name: "Edit" }).first().click();
    const editor = page.getByRole("dialog", { name: "Edit Member" });
    await expect(editor.getByLabel("Availability (derived)")).toBeDisabled();
    await expect(editor.getByLabel("Training status (derived)")).toBeDisabled();
    await expect(editor.getByLabel("Roster status (derived)")).toBeDisabled();
    await editor.getByLabel("Last name").fill("Changed");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(editor.getByText("This record changed while you were reviewing it. Refresh and try again")).toBeVisible();
    expect(updatePayload).toMatchObject({ expectedVersion: 7, lastName: "Changed" });
    expect(updatePayload).not.toHaveProperty("availability");
    expect(updatePayload).not.toHaveProperty("trainingStatus");
    expect(updatePayload).not.toHaveProperty("rosterStatus");

    await editor.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText("Profile archived")).toBeVisible();
    expect(archivePayload).toMatchObject({ expectedVersion: 7 });
    await page.getByRole("button", { name: "New member" }).click();
    const createEditor = page.getByRole("dialog", { name: "New Member" });
    await createEditor.getByLabel("First name").fill("Created");
    await createEditor.getByLabel("Last name").fill("Member");
    await createEditor.getByLabel("Email").fill("created@example.test");
    await createEditor.getByLabel("Phone").fill("+48 600 000 002");
    await createEditor.getByRole("button", { name: "Create member" }).click();
    await expect.poll(() => createPayload).toBeTruthy();
    await expect(page.getByText("Member created")).toBeVisible();
    expect(createPayload).not.toHaveProperty("availability");
    expect(createPayload).not.toHaveProperty("trainingStatus");
    expect(createPayload).not.toHaveProperty("rosterStatus");

    await page.getByLabel("Search members").fill("Bravo");
    await expect(page.getByText("Bravo Member").first()).toBeVisible();
    await expect.poll(() => memberGets.some((url) => url.searchParams.get("search") === "Bravo")).toBe(true);
    await page.getByLabel("Status filter").selectOption("Archived");
    await expect.poll(() => memberGets.some((url) => url.searchParams.get("status") === "Archived")).toBe(true);
    expect(memberGets.every((url) => Number(url.searchParams.get("limit")) <= 25)).toBe(true);
  });

  test("uses controlled membership writes and surfaces a stale Group conflict", async ({ page }) => {
    const groupGets: URL[] = [];
    const baseGroup = {
      id: "grp-stage9-a",
      operationalId: "GRP-2026-000901",
      incidentId: "ses-demo-1",
      sessionId: "ses-demo-1",
      name: "Stage 9 Alpha Group",
      pool: "ZPP",
      functionName: "Welfare Support",
      status: "Active",
      notes: "Stage 9",
      version: 3,
      leaderId: alpha.id,
      leaderName: alpha.displayName,
      leaderMemberId: alpha.memberId,
      memberIds: [alpha.id],
      memberCount: 1,
      memberships: [{ id: "gmb-stage9-a", groupId: "grp-stage9-a", memberProfileId: alpha.id, role: "Leader" }],
      rosterShiftIds: [],
      rosterLinkCount: 0,
    };
    let membershipPayload: Record<string, unknown> | undefined;
    let removalPayload: Record<string, unknown> | undefined;
    let groupUpdatePayload: Record<string, unknown> | undefined;
    let groupArchivePayload: Record<string, unknown> | undefined;

    await page.route("**/api/sessions**", async (route) => {
      if (route.request().method() === "GET") {
        await json(route, 200, { total: 1, data: [{ id: "ses-demo-1", operationalId: "ERP-STAGE9", mode: "EXERCISE", status: "Active", updatedAt: "2026-08-10T00:00:00.000Z" }] });
      } else await route.continue();
    });
    await page.route("**/api/member-profiles**", async (route) => {
      if (route.request().method() === "GET") await json(route, 200, { total: 2, limit: 100, offset: 0, data: [alpha, bravo] });
      else await route.continue();
    });
    await page.route("**/api/groups**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/api/groups") {
        groupGets.push(url);
        await json(route, 200, { total: 2, limit: 100, offset: 0, data: [baseGroup, { ...baseGroup, id: "grp-stage9-b", operationalId: "GRP-2026-000902", name: "Stage 9 Bravo Group" }] });
        return;
      }
      if (request.method() === "GET" && url.pathname === `/api/groups/${baseGroup.id}/members`) {
        await json(route, 200, { total: 1, limit: 200, offset: 0, data: [alpha] });
        return;
      }
      if (request.method() === "POST" && url.pathname.endsWith("/members")) {
        membershipPayload = request.postDataJSON();
        await json(route, 201, { ...baseGroup, version: 4, memberIds: [alpha.id, bravo.id], memberCount: 2, memberships: [...baseGroup.memberships, { id: "gmb-stage9-b", groupId: baseGroup.id, memberProfileId: bravo.id, role: "Member" }] });
        return;
      }
      if (request.method() === "POST" && url.pathname.endsWith("/archive")) {
        groupArchivePayload = request.postDataJSON();
        await json(route, 200, { ...baseGroup, status: "Archived", version: 6, memberIds: [], memberCount: 0, memberships: [] });
        return;
      }
      if (request.method() === "DELETE" && url.pathname.endsWith(`/members/${bravo.id}`)) {
        removalPayload = request.postDataJSON();
        await json(route, 200, { ...baseGroup, version: 5 });
        return;
      }
      if (request.method() === "PATCH" && url.pathname === `/api/groups/${baseGroup.id}`) {
        groupUpdatePayload = request.postDataJSON();
        await json(route, 409, { error: "This record changed while you were reviewing it. Refresh and try again" });
        return;
      }
      await route.continue();
    });

    await login(page, "admin@lot.pl");
    await page.goto("/groups");
    await expect(page.getByText("Stage 9 Alpha Group")).toBeVisible();
    await expect(page.getByText("Stage 9 Bravo Group")).toBeVisible();
    await page.getByRole("button", { name: "Edit Stage 9 Alpha Group" }).click();
    const editor = page.getByRole("dialog", { name: "Edit Group" });
    await expect(editor.getByLabel("Roster shift IDs")).toBeDisabled();
    await editor.getByRole("button", { name: `Add ${bravo.memberId}` }).click();
    await expect.poll(() => membershipPayload).toBeTruthy();
    await expect(editor.getByText("Bravo Member", { exact: true })).toBeVisible();
    expect(membershipPayload).toMatchObject({ memberProfileId: bravo.id, expectedVersion: 3, sessionId: "ses-demo-1" });
    await editor.getByRole("button", { name: "Remove" }).last().click();
    await expect.poll(() => removalPayload).toBeTruthy();
    expect(removalPayload).toMatchObject({ expectedVersion: 4, sessionId: "ses-demo-1" });

    await editor.getByLabel("Group name").fill("Stage 9 Stale Edit");
    await editor.getByRole("button", { name: "Save group" }).click();
    await expect(editor.getByText("This record changed while you were reviewing it. Refresh and try again")).toBeVisible();
    expect(groupUpdatePayload).toMatchObject({ expectedVersion: 5, name: "Stage 9 Stale Edit", sessionId: "ses-demo-1" });
    expect(groupUpdatePayload).not.toHaveProperty("memberIds");
    expect(groupUpdatePayload).not.toHaveProperty("rosterShiftIds");
    await editor.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText("Group archived")).toBeVisible();
    expect(groupArchivePayload).toMatchObject({ expectedVersion: 5, sessionId: "ses-demo-1" });
    expect(groupGets.every((url) => Number(url.searchParams.get("limit")) <= 100)).toBe(true);
  });
});

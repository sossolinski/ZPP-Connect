import { expect, test, type Route } from "@playwright/test";
import { login } from "./helpers";

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function stableSession(page: Parameters<typeof login>[0]) {
  await page.route("**/api/sessions**", async (route) => {
    if (route.request().method() === "GET") {
      await json(route, 200, { total: 1, limit: 50, offset: 0, data: [{ id: "ses-demo-1", operationalId: "SES-2026-001", mode: "EXERCISE", status: "Active", eventType: "Stage 10 browser", updatedAt: "2026-08-10T08:00:00.000Z" }] });
    } else await route.continue();
  });
}

test("uses bounded Rostering pages, human-review warnings and versioned operation IDs", async ({ page }) => {
  await stableSession(page);
  const rosterGets: URL[] = [];
  const availabilityGets: URL[] = [];
  let updatePayload: Record<string, unknown> | undefined;
  let publishPayload: Record<string, unknown> | undefined;
  let removePayload: Record<string, unknown> | undefined;
  const shift = {
    id: "rst-stage10-1",
    operationalId: "RST-1001",
    sessionId: "ses-demo-1",
    groupId: null,
    assignedMemberProfileId: "mem-2026-000003",
    title: "Stage 10 controlled roster shift",
    duty: "Family support",
    functionName: "Family Assistance Team",
    startAt: "2026-09-20T08:00:00.000Z",
    endAt: "2026-09-20T12:00:00.000Z",
    location: "Family Assistance Centre",
    status: "Draft",
    notes: "Review before publishing",
    version: 7,
    updatedAt: "2026-08-10T08:00:00.000Z",
    assignedMember: { id: "mem-2026-000003", memberId: "ZPP-006", displayName: "Marta Zielinska", status: "Active" },
    group: null,
    conflictWarnings: ["Unavailable during this shift (AVL-1001)"],
    warningDetails: [{ code: "UNAVAILABLE", message: "Unavailable during this shift (AVL-1001)", sourceId: "avl-stage10-1" }],
    permissions: { canUpdate: true, canPublish: true, canCancel: true },
  };
  const availability = {
    id: "avl-stage10-1",
    operationalId: "AVL-1001",
    memberProfileId: "mem-2026-000003",
    startAt: "2026-09-20T08:00:00.000Z",
    endAt: "2026-09-20T12:00:00.000Z",
    type: "Unavailable",
    note: "Declared by member",
    status: "Active",
    version: 4,
    updatedAt: "2026-08-10T08:00:00.000Z",
    member: shift.assignedMember,
    permissions: { canUpdate: true, canRemove: true },
  };

  await page.route("**/api/roster-shifts**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/roster-shifts") {
      rosterGets.push(url);
      await json(route, 200, { total: 75, limit: Number(url.searchParams.get("limit")), offset: Number(url.searchParams.get("offset")), data: [shift] });
      return;
    }
    if (request.method() === "PATCH" && url.pathname === `/api/roster-shifts/${shift.id}`) {
      updatePayload = request.postDataJSON();
      await json(route, 409, { error: "This roster shift changed while you were working. Refresh the current version before trying again" });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/publish")) {
      publishPayload = request.postDataJSON();
      await json(route, 200, { ...shift, status: "Published", version: 8, permissions: { canUpdate: true, canCancel: true } });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/availability**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/availability") {
      availabilityGets.push(url);
      await json(route, 200, { total: 65, limit: Number(url.searchParams.get("limit")), offset: Number(url.searchParams.get("offset")), data: [availability] });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/remove")) {
      removePayload = request.postDataJSON();
      await json(route, 200, { ...availability, status: "Removed", version: 5, removedAt: "2026-08-10T09:00:00.000Z", permissions: { canUpdate: false, canRemove: false } });
      return;
    }
    await route.continue();
  });

  await login(page, "admin@lot.pl");
  await page.goto("/rostering");
  await expect(page.getByText(shift.title)).toBeVisible();
  expect(rosterGets[0]?.searchParams.get("limit")).toBe("50");
  expect(rosterGets[0]?.searchParams.get("offset")).toBe("0");
  expect(availabilityGets[0]?.searchParams.get("limit")).toBe("50");
  expect(availabilityGets[0]?.searchParams.get("offset")).toBe("0");

  await page.getByRole("button", { name: "Next" }).first().click();
  await expect.poll(() => rosterGets.some((url) => url.searchParams.get("offset") === "50")).toBe(true);

  await page.getByRole("button", { name: "Remove" }).click();
  await expect.poll(() => removePayload).toBeTruthy();
  expect(removePayload).toMatchObject({ expectedVersion: 4 });
  expect(String(removePayload?.operationId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  await page.getByRole("row", { name: new RegExp(shift.operationalId) }).getByRole("button", { name: "Edit" }).click();
  const drawer = page.getByRole("dialog", { name: shift.operationalId });
  await expect(drawer.getByText("Planner review required — these warnings do not change the roster automatically.")).toBeVisible();
  await expect(drawer.getByText("Unavailable during this shift (AVL-1001)")).toBeVisible();
  await drawer.getByLabel("Title").fill("Stage 10 stale edit");
  await drawer.getByRole("button", { name: "Save changes" }).click();
  await expect(drawer.getByText("This roster shift changed while you were working. Refresh the current version before trying again")).toBeVisible();
  expect(updatePayload).toMatchObject({ sessionId: "ses-demo-1", expectedVersion: 7, title: "Stage 10 stale edit" });

  await drawer.getByRole("button", { name: "Publish" }).click();
  await expect.poll(() => publishPayload).toBeTruthy();
  expect(publishPayload).toMatchObject({ sessionId: "ses-demo-1", expectedVersion: 7 });
  expect(String(publishPayload?.operationId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("keeps confirm, decline, cancel and complete as explicit versioned human commands", async ({ page }) => {
  await stableSession(page);
  const commands = new Map<string, Record<string, unknown>>();
  const base = {
    sessionId: "ses-demo-1",
    groupId: null,
    assignedMemberProfileId: "mem-2026-000003",
    duty: "Controlled action",
    functionName: "Family Assistance Team",
    startAt: "2026-09-21T08:00:00.000Z",
    endAt: "2026-09-21T12:00:00.000Z",
    location: "Command room",
    notes: null,
    updatedAt: "2026-08-10T08:00:00.000Z",
    assignedMember: { id: "mem-2026-000003", memberId: "ZPP-006", displayName: "Marta Zielinska", status: "Active" },
    group: null,
    conflictWarnings: [],
  };
  const shifts = [
    { ...base, id: "rst-confirm", operationalId: "RST-1101", title: "Confirm command", status: "Published", version: 2, permissions: { canConfirm: true } },
    { ...base, id: "rst-decline", operationalId: "RST-1102", title: "Decline command", status: "Published", version: 3, permissions: { canDecline: true } },
    { ...base, id: "rst-cancel", operationalId: "RST-1103", title: "Cancel command", status: "Draft", version: 4, permissions: { canUpdate: true, canCancel: true } },
    { ...base, id: "rst-complete", operationalId: "RST-1104", title: "Complete command", status: "Confirmed", version: 5, permissions: { canUpdate: true, canComplete: true, canCancel: true } },
  ];
  await page.route("**/api/roster-shifts**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/roster-shifts") {
      await json(route, 200, { total: shifts.length, limit: 50, offset: 0, data: shifts });
      return;
    }
    if (request.method() === "POST") {
      const action = url.pathname.split("/").at(-1)!;
      const record = shifts.find((item) => url.pathname.includes(item.id))!;
      commands.set(action, request.postDataJSON());
      const status = action === "confirm" ? "Confirmed" : action === "decline" ? "Declined" : action === "cancel" ? "Cancelled" : "Completed";
      await json(route, 200, { ...record, status, version: record.version + 1, permissions: {} });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/availability**", async (route) => {
    if (route.request().method() === "GET") await json(route, 200, { total: 0, limit: 50, offset: 0, data: [] });
    else await route.continue();
  });

  await login(page, "admin@lot.pl");
  await page.goto("/rostering");
  await page.getByRole("row", { name: /RST-1101/ }).getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("row", { name: /RST-1102/ }).getByRole("button", { name: "Decline" }).click();

  await page.getByRole("row", { name: /RST-1103/ }).getByRole("button", { name: "Edit" }).click();
  let drawer = page.getByRole("dialog", { name: "RST-1103" });
  await drawer.getByRole("button", { name: "Cancel shift" }).click();
  await drawer.getByRole("button", { name: "Close" }).last().click();

  await page.getByRole("row", { name: /RST-1104/ }).getByRole("button", { name: "Edit" }).click();
  drawer = page.getByRole("dialog", { name: "RST-1104" });
  await drawer.getByRole("button", { name: "Complete" }).click();

  await expect.poll(() => commands.size).toBe(4);
  for (const [action, version] of [["confirm", 2], ["decline", 3], ["cancel", 4], ["complete", 5]] as const) {
    expect(commands.get(action)).toMatchObject({ sessionId: "ses-demo-1", expectedVersion: version });
    expect(String(commands.get(action)?.operationId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  }
});

test("keeps own Availability scoped and supports explicit add and edit", async ({ page }) => {
  await stableSession(page);
  const availabilityGets: URL[] = [];
  let createPayload: Record<string, unknown> | undefined;
  let updatePayload: Record<string, unknown> | undefined;
  const member = { id: "mem-2026-000008", memberId: "ZPP-221", displayName: "Adam Dabrowski", status: "Active" };
  const record = {
    id: "avl-own-1",
    operationalId: "AVL-1201",
    memberProfileId: member.id,
    startAt: "2026-09-22T08:00:00.000Z",
    endAt: "2026-09-22T12:00:00.000Z",
    type: "Available",
    note: "Own window",
    status: "Active",
    version: 6,
    updatedAt: "2026-08-10T08:00:00.000Z",
    member,
    permissions: { canUpdate: true, canRemove: true },
  };
  await page.route("**/api/roster-shifts**", async (route) => {
    if (route.request().method() === "GET") await json(route, 200, { total: 0, limit: 50, offset: 0, data: [], linkedMemberProfile: member });
    else await route.continue();
  });
  await page.route("**/api/availability**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      availabilityGets.push(url);
      await json(route, 200, { total: 1, limit: 50, offset: 0, data: [record], linkedMemberProfile: member });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/availability") {
      createPayload = request.postDataJSON();
      await json(route, 201, { ...record, ...createPayload, id: "avl-own-created", operationalId: "AVL-1202", version: 1 });
      return;
    }
    if (request.method() === "PATCH") {
      updatePayload = request.postDataJSON();
      await json(route, 200, { ...record, ...updatePayload, version: 7 });
      return;
    }
    await route.continue();
  });

  await login(page, "volunteer@lot.pl");
  await page.goto("/rostering");
  await expect.poll(() => availabilityGets.length).toBeGreaterThan(0);
  expect(availabilityGets.every((url) => url.searchParams.get("mine") === "true")).toBe(true);
  await expect(page.getByRole("heading", { name: "My availability" })).toBeVisible();
  await expect(page.getByLabel("Member", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Add availability" }).click();
  await page.getByLabel("Start").last().fill("2026-09-23T08:00");
  await page.getByLabel("End").last().fill("2026-09-23T12:00");
  await page.getByLabel("Type").last().selectOption("Preferred");
  await page.getByLabel("Note").last().fill("Own preferred window");
  await page.getByRole("button", { name: "Save availability" }).click();
  await expect.poll(() => createPayload).toBeTruthy();
  expect(createPayload).not.toHaveProperty("memberProfileId");
  expect(String(createPayload?.operationId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  await page.getByRole("row", { name: /AVL-1201|Adam Dabrowski/ }).getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Note").last().fill("Updated own window");
  await page.getByRole("button", { name: "Save availability" }).click();
  await expect.poll(() => updatePayload).toBeTruthy();
  expect(updatePayload).toMatchObject({ expectedVersion: 6, note: "Updated own window" });
  expect(updatePayload).not.toHaveProperty("memberProfileId");
});

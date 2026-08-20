import { expect, test, type Page, type Route } from "@playwright/test";
import { login } from "./helpers";

test.setTimeout(60_000);

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

const member = { id: "mem-stage12-1", memberId: "ZPP-1201", displayName: "Stage Twelve Member", pool: "ZPP", role: "Member", assignedFunction: "Family Assistance", status: "Active" };
const farMember = { ...member, id: "mem-stage12-1001", memberId: "ZPP-2201", displayName: "Member Beyond Page 20" };
const group = { id: "grp-stage12-1", operationalId: "GRP-1201", incidentId: "incident-stage12", sessionId: "incident-stage12", name: "Stage Twelve Group", pool: "ZPP", functionName: "Family Assistance", status: "Active", memberCount: 14 };
const published = { id: "dver-stage12-published", documentId: "doc-stage12-1", title: "Stage 12 Playbook", versionLabel: "v1.0", status: "Published", contentMode: "Internal text", contentAvailable: true, contentBody: "Controlled plain text", contentDigest: "a".repeat(64), effectiveFrom: "2026-08-01T09:00:00.000Z", reviewDueAt: "2026-12-01T09:00:00.000Z", publishedAt: "2026-08-01T10:00:00.000Z", publishedById: "actor-publisher", requirementCount: 12, acknowledgementCount: 5, outstandingCount: 7, version: 2, updatedAt: "2026-08-01T10:00:00.000Z" };
const draft = { ...published, id: "dver-stage12-draft", versionLabel: "v2.0", status: "Draft", contentBody: "Next controlled version", contentDigest: null, publishedAt: null, publishedById: null, requirementCount: 0, acknowledgementCount: 0, outstandingCount: 0, version: 4 };
const documentRecord = { id: "doc-stage12-1", code: "ST12-PLAYBOOK", title: "Stage 12 Playbook", description: "Controlled guidance", category: "Operations", ownerFunction: "ZPP", active: true, status: "Active", currentVersion: published, versionCount: 2, activeRequirementCount: 12, acknowledgementCount: 5, outstandingCount: 7, version: 6, updatedAt: "2026-08-01T10:00:00.000Z" };
const requirement = { id: "dreq-stage12-1", documentVersionId: published.id, documentId: documentRecord.id, document: documentRecord, version: published, targetType: "MemberProfile", memberProfileId: farMember.id, target: { type: "MemberProfile", label: farMember.displayName, member: farMember }, targetLabel: farMember.displayName, acknowledgementRequired: true, effectiveFrom: "2026-08-01T09:00:00.000Z", dueAt: "2026-08-21T09:00:00.000Z", active: true, effective: true, resolvedMemberCount: 1, versionNumber: 3, recordVersion: 3, updatedAt: "2026-08-01T10:00:00.000Z" };

async function routeLookups(page: Page, memberUrls: URL[] = []) {
  await page.route("**/api/member-profiles**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.pathname !== "/api/member-profiles") return route.continue();
    memberUrls.push(url);
    const data = url.searchParams.get("search") ? [farMember] : [member];
    await json(route, 200, { total: 1001, limit: 50, offset: 0, data });
  });
  await page.route("**/api/groups**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/api/groups") await json(route, 200, { total: 1, limit: 50, offset: 0, data: [group] });
    else await route.continue();
  });
}

test("uses server paging, explicit version commands, publication warning and safe content rendering", async ({ page }) => {
  const documentGets: URL[] = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  await routeLookups(page);
  await page.route(/\/api\/document-requirements(?:\/.*)?(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") await json(route, 200, { total: 61, limit: 50, offset: 0, data: [requirement] });
    else await route.continue();
  });
  await page.route("**/api/document-acknowledgements**", async (route) => {
    if (route.request().method() === "GET") await json(route, 200, { total: 0, limit: 50, offset: 0, data: [] });
    else await route.continue();
  });
  await page.route("**/api/document-versions/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/content")) return json(route, 200, { ...published, contentBody: "<script>window.compromised=true</script>" });
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      writes.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/publish")) return json(route, 200, { ...draft, ...body, status: "Published", version: 5 });
      if (url.pathname.endsWith("/withdraw")) return json(route, 200, { ...published, status: "Withdrawn", version: 3, withdrawReason: body.reason });
    }
    await route.continue();
  });
  await page.route("**/api/documents**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/documents") {
      documentGets.push(url);
      return json(route, 200, { total: 71, limit: 50, offset: Number(url.searchParams.get("offset") ?? 0), data: [documentRecord], totals: { documents: 71, published: 63, requirements: 207, outstanding: 19, overdue: 8, acknowledged: 188 } });
    }
    if (request.method() === "GET" && url.pathname === `/api/documents/${documentRecord.id}/versions`) return json(route, 200, { total: 2, limit: 200, offset: 0, data: [draft, published] });
    if (request.method() === "PATCH") {
      const body = request.postDataJSON();
      writes.push({ path: url.pathname, body });
      return json(route, 409, { error: "This document changed. Refresh and try again" });
    }
    await route.continue();
  });

  await login(page, "admin@lot.pl");
  await page.goto("/documents");
  await expect(page.getByText("71").first()).toBeVisible();
  expect(documentGets[0]?.searchParams.get("limit")).toBe("50");
  await page.getByLabel("Search documents").fill("playbook");
  await expect.poll(() => documentGets.some((url) => url.searchParams.get("search") === "playbook" && url.searchParams.get("offset") === "0")).toBe(true);
  await page.getByRole("button", { name: "Next" }).first().click();
  await expect.poll(() => documentGets.some((url) => url.searchParams.get("offset") === "50")).toBe(true);

  await page.getByRole("button", { name: "Versions" }).click();
  const versionsDialog = page.getByRole("dialog", { name: "Document versions" });
  let warning = "";
  page.once("dialog", async (dialog) => { warning = dialog.message(); await dialog.accept(); });
  await versionsDialog.getByRole("button", { name: "Publish" }).click();
  await expect.poll(() => warning).toContain("Requirements do not automatically carry forward");
  const publishWrite = writes.find(({ path }) => path.endsWith("/publish"))!;
  expect(publishWrite.body).toMatchObject({ expectedVersion: 4, expectedCurrentPublishedVersionId: published.id });
  expect(String(publishWrite.body.operationId)).toMatch(/^[0-9a-f-]{36}$/i);

  await versionsDialog.getByRole("button", { name: "Read" }).last().click();
  const contentDialog = page.getByRole("dialog", { name: "Document content" });
  await expect(contentDialog.getByText("<script>window.compromised=true</script>", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).compromised)).toBeUndefined();
  await contentDialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("row", { name: /ST12-PLAYBOOK/ }).getByRole("button", { name: "Edit" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit document" });
  await editDialog.getByLabel("Title").fill("Stale title");
  await editDialog.getByRole("button", { name: "Save document" }).click();
  await expect(editDialog.getByText("This document changed. Refresh and try again")).toBeVisible();
  expect(writes.find(({ path }) => path === `/api/documents/${documentRecord.id}`)?.body.expectedVersion).toBe(6);
});

test("uses bounded target search and records explicit immutable on-behalf acknowledgement", async ({ page }) => {
  const memberUrls: URL[] = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  await routeLookups(page, memberUrls);
  await page.route("**/api/documents**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/api/documents") await json(route, 200, { total: 1, limit: 50, offset: 0, data: [documentRecord], totals: { documents: 1, published: 1, requirements: 1, outstanding: 1, overdue: 1, acknowledged: 0 } });
    else await route.continue();
  });
  await page.route("**/api/document-acknowledgements**", async (route) => {
    if (route.request().method() === "GET") await json(route, 200, { total: 0, limit: 50, offset: 0, data: [] });
    else await route.continue();
  });
  await page.route(/\/api\/document-requirements(?:\/.*)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") return json(route, 200, { total: 1, limit: 50, offset: 0, data: [requirement] });
    const body = request.postDataJSON();
    writes.push({ path: url.pathname, body });
    await json(route, 200, { ...requirement, ...body, recordVersion: 4, active: !url.pathname.endsWith("/end") });
  });
  await page.route("**/api/document-versions/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/acknowledge")) {
      const body = request.postDataJSON();
      writes.push({ path: url.pathname, body });
      return json(route, 201, { id: "dack-stage12", memberProfileId: body.memberProfileId, acknowledgedById: "admin-actor", onBehalf: true, sourceRequirementIds: [requirement.id] });
    }
    await route.continue();
  });

  await login(page, "admin@lot.pl");
  await page.goto("/documents");
  const row = page.getByRole("row", { name: new RegExp(farMember.displayName) });
  await row.getByRole("button", { name: "Acknowledge on behalf" }).click();
  const behalfDialog = page.getByRole("dialog", { name: "Acknowledge on behalf" });
  await expect(behalfDialog.getByText("cannot be edited or deleted")).toBeVisible();
  await behalfDialog.getByLabel("Search members for acknowledgement").fill("Beyond Page 20");
  await expect.poll(() => memberUrls.some((url) => url.searchParams.get("search") === "Beyond Page 20" && url.searchParams.get("limit") === "50")).toBe(true);
  await behalfDialog.getByRole("combobox", { name: "Member" }).selectOption(farMember.id);
  await behalfDialog.getByLabel("Reason / note").fill("Confirmed during facilitated review");
  await behalfDialog.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect.poll(() => writes.some(({ path }) => path.endsWith("/acknowledge"))).toBe(true);
  const acknowledgement = writes.find(({ path }) => path.endsWith("/acknowledge"))!;
  expect(acknowledgement.body).toMatchObject({ memberProfileId: farMember.id, onBehalf: true, note: "Confirmed during facilitated review" });
  expect(String(acknowledgement.body.operationId)).toMatch(/^[0-9a-f-]{36}$/i);

  const discard = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  if (await discard.isVisible().catch(() => false)) await discard.getByRole("button", { name: "Discard changes" }).click();
  await row.getByRole("button", { name: "Edit" }).click();
  const requirementDialog = page.getByRole("dialog", { name: "Edit document requirement" });
  await requirementDialog.getByLabel("Due").fill("2026-09-01T09:00");
  await requirementDialog.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect.poll(() => writes.some(({ path }) => path === `/api/document-requirements/${requirement.id}`)).toBe(true);
  expect(writes.find(({ path }) => path === `/api/document-requirements/${requirement.id}`)?.body.expectedVersion).toBe(3);
});

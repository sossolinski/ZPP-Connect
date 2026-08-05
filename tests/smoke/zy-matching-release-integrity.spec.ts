import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const headers = { "content-type": "application/json", "x-user-email": "coordinator@lot.pl" };
const cleanupSessionIds: string[] = [];
type Row = Record<string, any>;

async function apiPost(page: Page, path: string, data: Row) {
  const response = await page.request.post(`${apiUrl}${path}`, { headers, data });
  return { response, body: await response.json() };
}

async function apiGet(page: Page, path: string, query: Row) {
  const url = new URL(`${apiUrl}${path}`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await page.request.get(url.toString(), { headers });
  return { response, body: await response.json() };
}

async function createSession(page: Page, token: string) {
  const result = await apiPost(page, "/sessions", { mode: "EXERCISE", status: "Active", eventType: "Exercise", flightNumber: token, route: "WAW-TEST", description: "Foundation Stage 5 browser fixture" });
  expect(result.response.status()).toBe(201);
  cleanupSessionIds.push(result.body.id);
  return result.body;
}

async function createFixture(page: Page, sessionId: string, token: string) {
  const passenger = await apiPost(page, "/passenger-records", { sessionId, caseId: `CASE-${token}`, personType: "Passenger", firstName: "Passenger", lastName: token, flightNumber: `LO-${token}`, route: "WAW-TEST", source: "Manual" });
  expect(passenger.response.status()).toBe(201);
  const family = await apiPost(page, "/family-records", { sessionId, caseId: `CASE-${token}`, firstName: "Family", lastName: token, claimedRelationship: "Sibling", passengerFirstName: passenger.body.firstName, passengerLastName: passenger.body.lastName, passengerFlight: passenger.body.flightNumber });
  expect(family.response.status()).toBe(201);
  return { passenger: passenger.body, family: family.body, claim: family.body.currentClaim };
}

async function useSession(page: Page, session: Row) {
  await page.goto("/sessions");
  const row = page.getByRole("row").filter({ hasText: session.operationalId });
  await expect(row).toBeVisible();
  const button = row.getByRole("button", { name: "Use this session" });
  if (await button.count()) await button.click();
  await expect(page.locator(`[aria-label*="Current session EXERCISE ${session.operationalId}"]:visible`)).toHaveCount(1);
}

async function confirmViaApi(page: Page, sessionId: string, claim: Row, passenger: Row, operationId = crypto.randomUUID()) {
  return apiPost(page, `/matching/claims/${claim.id}/confirm`, {
    sessionId,
    passengerRecordId: passenger.id,
    reason: "Browser fixture human decision with reviewed source evidence.",
    expectedClaimVersion: claim.version,
    expectedPassengerVersion: passenger.version,
    operationId
  });
}

test.afterEach(async ({ page }) => {
  for (const sessionId of cleanupSessionIds.splice(0)) {
    await page.request.post(`${apiUrl}/sessions/${sessionId}/close`, { headers, data: { notes: "Foundation Stage 5 browser cleanup" } }).catch(() => undefined);
  }
});

test("keeps explainable suggestions separate from an explicit human confirmation", async ({ page }) => {
  const token = `F5-SUG-${Date.now()}`;
  const session = await createSession(page, token);
  const value = await createFixture(page, session.id, token);
  await login(page);
  await useSession(page, session);
  await page.goto("/matching");

  await expect(page.getByRole("main").getByRole("heading", { name: "Matching workspace" })).toBeVisible();
  await expect(page.getByText(value.family.operationalId, { exact: false })).toBeVisible();
  await expect(page.getByText("Nothing is confirmed automatically.")).toBeVisible();
  await page.getByRole("button", { name: "Generate suggestions" }).click();
  const suggestion = page.locator("article").filter({ hasText: value.passenger.operationalId });
  await expect(suggestion).toContainText("zpp-deterministic-candidate v1.0.0");
  await expect(suggestion.getByText("Positive signals")).toBeVisible();
  await expect(suggestion.getByText("Conflicts", { exact: true })).toBeVisible();

  const beforeDecision = await apiGet(page, "/matching-records", { sessionId: session.id, search: `CASE-${token}` });
  expect(beforeDecision.body.data).toHaveLength(0);
  await suggestion.getByRole("button", { name: "Reject suggestion" }).click();
  const rejectDialog = page.getByRole("dialog", { name: "Reject algorithm suggestion" });
  await rejectDialog.getByLabel("Decision reason").fill("Operator found that the current evidence does not support this suggestion.");
  await rejectDialog.getByRole("button", { name: "Reject suggestion" }).click();
  await expect(page.getByText("No current suggestions")).toBeVisible();
  const rejected = await apiGet(page, `/matching/claims/${value.claim.id}/suggestions`, { sessionId: session.id, status: "REJECTED" });
  expect(rejected.body.data).toHaveLength(1);
  await page.getByRole("button", { name: "Generate suggestions" }).click();
  await expect(suggestion).toContainText("zpp-deterministic-candidate v1.0.0");
  await suggestion.getByRole("button", { name: "Confirm match" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm passenger match" });
  await expect(dialog.getByText(/relationship is not verified/i)).toBeVisible();
  await expect(dialog.getByText("Signals reviewed")).toBeVisible();
  await expect(dialog.getByText("Conflicts reviewed")).toBeVisible();
  await expect(dialog.getByText(/same ID is retained after a timeout/i)).toBeVisible();
  await dialog.getByLabel("Decision reason").fill("Human reviewed the matching signals and authoritative passenger source.");
  await dialog.getByRole("button", { name: "Confirm match" }).click();
  await expect(page.getByText("Current human decision: CONFIRMED")).toBeVisible();
  await expect(page.getByText("Relationship verification")).toBeVisible();

  const family = await apiGet(page, `/family-records/${value.family.id}`, { sessionId: session.id });
  expect(family.body).toMatchObject({ verificationStatus: "Unverified", currentClaim: { status: "PENDING" } });
  const projection = await apiGet(page, "/matching-records", { sessionId: session.id, search: `CASE-${token}` });
  expect(projection.body.data[0]).toMatchObject({ status: "Verified match", releaseEligibility: { relationshipVerification: "NOT_VERIFIED", matchDecision: "CURRENT_CONFIRMED", eligible: false } });
});

test("supports manual matching without an invented score and preserves idempotent retry", async ({ page }) => {
  const token = `F5-MANUAL-${Date.now()}`;
  const session = await createSession(page, token);
  const value = await createFixture(page, session.id, token);
  const manual = await createFixture(page, session.id, `${token}-UI`);
  const operationId = crypto.randomUUID();
  const first = await confirmViaApi(page, session.id, value.claim, value.passenger, operationId);
  const retry = await confirmViaApi(page, session.id, value.claim, value.passenger, operationId);
  expect(first.response.status()).toBe(200);
  expect(retry.response.status()).toBe(200);
  expect(retry.body.idempotent).toBe(true);
  expect(retry.body.decisionHistory.filter((item: Row) => item.operationId === operationId)).toHaveLength(1);
  const projection = await apiGet(page, "/matching-records", { sessionId: session.id, search: `CASE-${token}` });
  expect(projection.body.data[0].matchScore).toBeNull();
  expect(projection.body.data[0].verificationChecklist).toEqual({ source: "manual" });

  await login(page);
  await useSession(page, session);
  await page.goto("/matching");
  await page.getByLabel("Matching claim queue").getByRole("button").filter({ hasText: `${token}-UI` }).click();
  await expect(page.getByText(/manual passenger selection/i)).toBeVisible();
  await page.getByLabel("Search passenger candidates").fill(manual.passenger.operationalId);
  await page.getByRole("main").getByRole("button", { name: "Search" }).last().click();
  const candidate = page.locator("div").filter({ hasText: manual.passenger.operationalId }).filter({ has: page.getByRole("button", { name: "Manual confirm" }) }).last();
  await candidate.getByRole("button", { name: "Manual confirm" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm passenger match" });
  await dialog.getByLabel("Decision reason").fill("Operator found the Passenger manually and reviewed authoritative source evidence.");
  await dialog.getByRole("button", { name: "Confirm match" }).click();
  await expect(page.getByText("Current human decision: CONFIRMED")).toBeVisible();
  const manualProjection = await apiGet(page, "/matching-records", { sessionId: session.id, search: `CASE-${token}-UI` });
  expect(manualProjection.body.data[0].matchScore).toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});

test("surfaces stale input and a human-resolvable 409 without automatic retry", async ({ page }) => {
  const token = `F5-CONFLICT-${Date.now()}`;
  const session = await createSession(page, token);
  const value = await createFixture(page, session.id, token);
  expect((await confirmViaApi(page, session.id, value.claim, value.passenger)).response.status()).toBe(200);
  const corrected = await apiPost(page, `/passenger-records/${value.passenger.id}/correct-source`, { sessionId: session.id, version: value.passenger.version, firstName: "Corrected", reason: "Manifest owner corrected the passenger source." });
  expect(corrected.response.status()).toBe(200);

  await login(page);
  await useSession(page, session);
  await page.goto("/matching");
  await expect(page.getByText("Review required.")).toBeVisible();
  await expect(page.getByText(/historical decision remains auditable/i)).toBeVisible();
  const candidate = page.locator("div").filter({ hasText: corrected.body.operationalId }).filter({ has: page.getByRole("button", { name: "Manual confirm" }) }).last();
  await candidate.getByRole("button", { name: "Manual confirm" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm passenger match" });
  await dialog.getByLabel("Decision reason").fill("Operator reviewed the corrected passenger data before reconfirming.");

  const external = await confirmViaApi(page, session.id, value.claim, corrected.body);
  expect(external.response.status()).toBe(200);
  await dialog.getByRole("button", { name: "Confirm match" }).click();
  await expect(dialog.getByText(/No automatic retry was attempted/)).toBeVisible();
  await expect(dialog.getByText(/same ID is retained after a timeout/i)).toBeVisible();
});

test("projects an independently verified current match into Release without starting Release", async ({ page }) => {
  const token = `F5-RELEASE-${Date.now()}`;
  const session = await createSession(page, token);
  const value = await createFixture(page, session.id, token);
  const verified = await apiPost(page, `/family-records/${value.family.id}/verify`, { sessionId: session.id, version: value.family.version, claimVersion: value.claim.version, basis: "Independent relationship evidence reviewed.", verifiedRelationshipType: "Sibling" });
  expect(verified.response.status()).toBe(200);
  const confirmed = await confirmViaApi(page, session.id, verified.body.currentClaim, value.passenger);
  expect(confirmed.response.status()).toBe(200);
  const projection = await apiGet(page, "/matching-records", { sessionId: session.id, search: `CASE-${token}` });
  const match = projection.body.data[0];
  expect(match).toMatchObject({ releaseEligibility: { relationshipVerification: "VERIFIED", matchDecision: "CURRENT_CONFIRMED", eligible: true } });

  await login(page);
  await useSession(page, session);
  await page.goto("/release-control");
  await page.getByRole("button", { name: "New" }).click();
  const drawer = page.getByRole("dialog", { name: "Prepare Action" });
  await expect(drawer.getByLabel("Match").getByRole("option", { name: new RegExp(match.operationalId) })).toHaveCount(1);
  await drawer.getByLabel("Match").selectOption(match.id);
  await expect(drawer.getByText(match.operationalId, { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Close" }).click();
  await page.getByRole("dialog", { name: "Discard unsaved changes?" }).getByRole("button", { name: "Discard changes" }).click();
});

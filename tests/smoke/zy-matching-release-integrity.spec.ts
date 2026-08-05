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

async function createSession(page: Page, token: string, mode = "EXERCISE", status = "Active") {
  const result = await apiPost(page, "/sessions", { mode, status, eventType: "Exercise", flightNumber: token, route: "WAW-TEST", description: "Foundation browser fixture" });
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
  await expect(page.locator(`[aria-label*="Current session ${session.mode} ${session.operationalId}"]:visible`)).toHaveCount(1);
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
    await page.request.post(`${apiUrl}/sessions/${sessionId}/close`, { headers, data: { notes: "Foundation Stage 6 browser cleanup" } }).catch(() => undefined);
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

test("separates preparation, checks, authorization and completion in Release Control", async ({ page }) => {
  const token = `F6-RELEASE-${Date.now()}`;
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
  await expect(page.getByText("ELIGIBLE ≠ PREPARED ≠ AUTHORIZED ≠ COMPLETED")).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare action" })).toBeEnabled();
  await page.getByRole("button", { name: "Prepare action" }).click();
  const prepareDialog = page.getByRole("dialog", { name: "Prepare release action" });
  await expect(prepareDialog.getByLabel("Current human match").getByRole("option", { name: new RegExp(value.passenger.operationalId) })).toHaveCount(1);
  await prepareDialog.getByLabel("Current human match").selectOption(match.matchDecisionId);
  await prepareDialog.getByLabel("Action type").selectOption("RELEASE");
  await prepareDialog.getByLabel("Receiving party").fill("Authorized browser-test recipient");
  await prepareDialog.getByLabel("Preparation notes").fill("Prepared for independent checks; no authorization implied.");
  await prepareDialog.getByRole("button", { name: "Prepare action" }).click();

  await expect(page.getByText(/prepared\. This is not authorization or completion/i)).toBeVisible();
  await expect(page.getByText("PREPARED", { exact: true }).first()).toBeVisible();
  await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(page.getByText("No independent checks")).toBeVisible();

  await page.getByRole("button", { name: "Identity check", exact: true }).click();
  const identityDialog = page.getByRole("dialog", { name: "Record identity check" });
  await identityDialog.getByLabel("Identity result").selectOption("PASS");
  await identityDialog.getByLabel("Evidence reference or type").fill("approved evidence type");
  await identityDialog.getByLabel("Check basis").fill("Identity evidence was reviewed by the assigned human operator.");
  await identityDialog.getByRole("button", { name: "Record identity check" }).click();
  await expect(page.getByText("IDENTITY PASS")).toBeVisible();

  await page.getByRole("button", { name: "Review hold" }).click();
  const holdDialog = page.getByRole("dialog", { name: "Record Passenger hold review" });
  await expect(holdDialog.getByText(/cannot clear or alter the hold/i)).toBeVisible();
  await holdDialog.getByLabel("Check basis").fill("The current Passenger hold state was independently reviewed.");
  await holdDialog.getByRole("button", { name: "Record Passenger hold review" }).click();
  await expect(page.getByText("HOLD_REVIEW PASS")).toBeVisible();

  await page.getByRole("button", { name: "Authorize" }).click();
  const authorizeDialog = page.getByRole("dialog", { name: "AUTHORIZE RELEASE" });
  await expect(authorizeDialog.getByText("Relationship verified")).toBeVisible();
  await expect(authorizeDialog.getByText("Current human match", { exact: true })).toBeVisible();
  await authorizeDialog.getByLabel("Human decision basis").fill("All current independent safety conditions were freshly reviewed.");
  await authorizeDialog.getByRole("button", { name: "AUTHORIZE RELEASE" }).click();
  await expect(page.getByText("AUTHORIZED", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete" })).toBeEnabled();

  await page.getByRole("button", { name: "Complete" }).click();
  const completionDialog = page.getByRole("dialog", { name: "COMPLETE RELEASE" });
  await completionDialog.getByLabel("Human decision basis").fill("The physical release handover was completed by the human operator.");
  await completionDialog.getByRole("button", { name: "COMPLETE RELEASE" }).click();
  await expect(page.getByText("COMPLETED", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete", exact: true })).toHaveCount(0);
});

test("shows upstream stale blockers and handles an authorization 409 without auto-retry", async ({ page }) => {
  const token = `F6-CONFLICT-${Date.now()}`;
  const session = await createSession(page, token);
  const value = await createFixture(page, session.id, token);
  const verified = await apiPost(page, `/family-records/${value.family.id}/verify`, { sessionId: session.id, version: value.family.version, claimVersion: value.claim.version, basis: "Relationship evidence reviewed.", verifiedRelationshipType: "Sibling" });
  const confirmed = await confirmViaApi(page, session.id, verified.body.currentClaim, value.passenger);
  expect(confirmed.response.status()).toBe(200);
  const prepared = await apiPost(page, "/releases/prepare", { sessionId: session.id, matchDecisionId: confirmed.body.currentDecision.id, actionType: "REUNIFICATION", operationId: crypto.randomUUID() });
  const identity = await apiPost(page, `/releases/${prepared.body.id}/checks/identity`, { sessionId: session.id, result: "PASS", basis: "Identity evidence reviewed for conflict test.", expectedVersion: prepared.body.version, operationId: crypto.randomUUID() });
  const hold = await apiPost(page, `/releases/${prepared.body.id}/checks/hold`, { sessionId: session.id, basis: "Current hold state reviewed for conflict test.", expectedVersion: identity.body.version, operationId: crypto.randomUUID() });

  await login(page);
  await useSession(page, session);
  await page.goto("/release-control");
  await page.getByRole("button", { name: new RegExp(prepared.body.operationalId) }).click();
  await page.getByRole("button", { name: "Authorize" }).click();
  const dialog = page.getByRole("dialog", { name: "AUTHORIZE REUNIFICATION" });
  await dialog.getByLabel("Human decision basis").fill("UI operator reviewed all current preconditions.");
  const external = await apiPost(page, `/releases/${prepared.body.id}/authorize`, { sessionId: session.id, reason: "Another operator authorized first.", expectedVersion: hold.body.version, operationId: crypto.randomUUID() });
  expect(external.response.status()).toBe(200);
  await dialog.getByRole("button", { name: "AUTHORIZE REUNIFICATION" }).click();
  await expect(dialog.getByText(/No automatic retry was attempted/)).toBeVisible();

  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("dialog", { name: "Discard unsaved changes?" }).getByRole("button", { name: "Discard changes" }).click();
  const held = await apiPost(page, `/passenger-records/${value.passenger.id}/change-hold`, { sessionId: session.id, version: value.passenger.version, holdStatus: "Security hold", reason: "A new security hold appeared after authorization." });
  expect(held.response.status()).toBe(200);
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText(/BLOCKED — active Passenger hold/i)).toBeVisible();
  await expect(page.getByText("REQUIRES_REVIEW", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete" })).toBeDisabled();
});

test("shows an explicit REAL human-authorization confirmation surface", async ({ page }) => {
  const token = `F6-REAL-${Date.now()}`;
  const session = await createSession(page, token, "REAL", "Draft");
  const value = await createFixture(page, session.id, token);
  const verified = await apiPost(page, `/family-records/${value.family.id}/verify`, { sessionId: session.id, version: value.family.version, claimVersion: value.claim.version, basis: "Relationship evidence reviewed for REAL confirmation test.", verifiedRelationshipType: "Sibling" });
  const confirmed = await confirmViaApi(page, session.id, verified.body.currentClaim, value.passenger);
  const prepared = await apiPost(page, "/releases/prepare", { sessionId: session.id, matchDecisionId: confirmed.body.currentDecision.id, actionType: "RELEASE", receivingParty: "Authorized REAL recipient", operationId: crypto.randomUUID() });
  const identity = await apiPost(page, `/releases/${prepared.body.id}/checks/identity`, { sessionId: session.id, result: "PASS", basis: "Identity evidence reviewed for REAL test.", expectedVersion: prepared.body.version, operationId: crypto.randomUUID() });
  await apiPost(page, `/releases/${prepared.body.id}/checks/hold`, { sessionId: session.id, basis: "Passenger hold state reviewed for REAL test.", expectedVersion: identity.body.version, operationId: crypto.randomUUID() });

  await login(page);
  await useSession(page, session);
  await page.goto("/release-control");
  await page.getByRole("button", { name: new RegExp(prepared.body.operationalId) }).click();
  await page.getByRole("button", { name: "Authorize" }).click();
  const dialog = page.getByRole("dialog", { name: "AUTHORIZE RELEASE" });
  await expect(dialog.getByText(/REAL INCIDENT — this is an operational human decision/i)).toBeVisible();
  await expect(dialog.getByText(new RegExp(value.passenger.lastName))).toBeVisible();
  await expect(dialog.getByText(new RegExp(value.family.lastName))).toBeVisible();
  await expect(dialog.getByText("Relationship verified")).toBeVisible();
  await expect(dialog.getByText("Current human match", { exact: true })).toBeVisible();
});

import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const headers = { "content-type": "application/json", "x-user-email": "coordinator@lot.pl" };
let cleanupSessionIds: string[] = [];

type Row = Record<string, any>;

async function apiPost(page: Page, path: string, data: Row) {
  const response = await page.request.post(`${apiUrl}${path}`, { headers, data });
  return { response, body: await response.json() };
}

async function createSession(page: Page, label: string) {
  const { response, body } = await apiPost(page, "/sessions", {
    mode: "EXERCISE",
    status: "Active",
    eventType: "Exercise",
    flightNumber: label,
    route: "WAW-TEST",
    description: "Ephemeral Stage 2B browser-test session"
  });
  expect(response.status()).toBe(201);
  cleanupSessionIds.push(body.id);
  return body;
}

async function createFamily(page: Page, sessionId: string, token: string, caseId = `CASE-${token}`) {
  const { response, body } = await apiPost(page, "/family-records", {
    sessionId,
    caseId,
    firstName: "Family",
    lastName: token,
    claimedRelationship: "Sibling",
    verificationStatus: "Partially verified"
  });
  expect(response.status()).toBe(201);
  return body;
}

async function createPassenger(page: Page, sessionId: string, token: string, caseId = `CASE-${token}`) {
  const { response, body } = await apiPost(page, "/passenger-records", {
    sessionId,
    caseId,
    firstName: "Passenger",
    lastName: token,
    flightNumber: token,
    source: "Manifest",
    conditionStatus: "Unknown",
    holdStatus: "No hold"
  });
  expect(response.status()).toBe(201);
  return body;
}

async function createMatch(page: Page, sessionId: string, familyId: string, passengerId: string, matchBasis = "Browser-test authoritative links") {
  const { response, body } = await apiPost(page, "/matching-records", {
    sessionId,
    familyRecordId: familyId,
    passengerRecordId: passengerId,
    matchBasis
  });
  expect(response.status()).toBe(201);
  return body;
}

async function verifyMatch(page: Page, matchId: string) {
  const { response } = await apiPost(page, `/matching-records/${matchId}/verify`, { decisionNotes: "Authoritative links reviewed in focused browser test." });
  expect(response.ok()).toBeTruthy();
}

async function useSession(page: Page, session: Row) {
  await page.goto("/sessions");
  const row = page.getByRole("row").filter({ hasText: session.operationalId });
  await expect(row).toBeVisible();
  const useButton = row.getByRole("button", { name: "Use this session" });
  if (await useButton.count()) await useButton.click();
  await expect(page.locator(`[aria-label*="Current session EXERCISE ${session.operationalId}"]:visible`)).toHaveCount(1);
}

test.afterEach(async ({ page }) => {
  for (const sessionId of cleanupSessionIds.splice(0)) {
    await page.request.post(`${apiUrl}/sessions/${sessionId}/close`, {
      headers,
      data: { notes: "Focused Stage 2B test cleanup" }
    }).catch(() => undefined);
  }
});

test("reaches unassigned records, supports keyboard matching, and validates authoritative links without a default score", async ({ page }) => {
  const token = `S2B-MATCH-${Date.now()}`;
  const session = await createSession(page, token);
  const familyA = await createFamily(page, session.id, `${token}-A`);
  const passengerA = await createPassenger(page, session.id, `${token}-A`);
  const familyB = await createFamily(page, session.id, `${token}-B`);
  const passengerB = await createPassenger(page, session.id, `${token}-B`);
  const familyStale = await createFamily(page, session.id, `${token}-STALE`);
  const passengerStale = await createPassenger(page, session.id, `${token}-STALE`);

  await login(page);
  await useSession(page, session);
  await page.goto("/matching");
  await page.getByRole("button", { name: "Suggestions / Unassigned" }).click();
  const workspace = page.getByRole("dialog", { name: "Suggestions & Unassigned" });
  await expect(workspace.getByText(familyA.operationalId, { exact: false })).toBeVisible();
  await expect(workspace.getByRole("paragraph").filter({ hasText: passengerA.operationalId })).toBeVisible();
  await expect(workspace.getByText("No system-generated suggestions")).toBeVisible();
  await workspace.getByLabel("Target PAX").selectOption(passengerA.id);
  await workspace.locator("div.rounded-md").filter({ hasText: familyA.operationalId }).getByRole("button", { name: "Add to selected PAX" }).click();
  await expect(workspace).not.toBeVisible();
  await page.getByRole("dialog", { name: "Record Inspector" }).getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "New" }).click();
  let drawer = page.getByRole("dialog", { name: "Create Potential Match" });
  await drawer.getByLabel("Passenger/Crew record").selectOption("");
  await drawer.getByRole("button", { name: "Create potential match" }).click();
  await expect(drawer.getByText("Select both a Family/NOK record and a Passenger/SRC record.")).toBeVisible();
  await drawer.getByLabel("Family/NOK record").selectOption(familyB.id);
  await drawer.getByLabel("Passenger/Crew record").selectOption(passengerB.id);
  await expect(drawer.getByLabel("Match score")).toHaveValue("");
  await expect(drawer.getByText("No confidence score. Manual matches do not receive a default value.")).toBeVisible();
  await drawer.getByRole("button", { name: "Create potential match" }).click();
  await expect(drawer).not.toBeVisible();

  const matchesResponse = await page.request.get(`${apiUrl}/matching-records?sessionId=${session.id}&limit=200`, { headers });
  const manualMatch = ((await matchesResponse.json()).data as Row[]).find((item) => item.familyRecordId === familyB.id && item.passengerRecordId === passengerB.id);
  expect(manualMatch).toMatchObject({ status: "Potential match", holdCheck: "No hold" });
  expect(manualMatch.matchScore ?? null).toBeNull();
  await page.getByRole("dialog", { name: "Record Inspector" }).getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "New" }).click();
  drawer = page.getByRole("dialog", { name: "Create Potential Match" });
  await drawer.getByLabel("Family/NOK record").selectOption(familyStale.id);
  await drawer.getByLabel("Passenger/Crew record").selectOption(passengerStale.id);
  const staleUpdate = await page.request.patch(`${apiUrl}/family-records/${familyStale.id}`, {
    headers,
    data: { sessionId: "different-session" }
  });
  expect(staleUpdate.ok()).toBeTruthy();
  await drawer.getByRole("button", { name: "Create potential match" }).click();
  await expect(drawer.getByText(/Family\/NOK record is missing, stale or belongs to another session/)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await drawer.getByRole("button", { name: "Close" }).click();
  await page.getByRole("dialog", { name: "Discard unsaved changes?" }).getByRole("button", { name: "Discard changes" }).click();
  await page.getByRole("button", { name: "Suggestions / Unassigned" }).click();
  await expect(page.getByRole("heading", { name: "Suggestions & Unassigned" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);

  await login(page, "viewer@lot.pl");
  await page.goto("/matching");
  await expect(page.getByRole("heading", { name: "Limited Access" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Suggestions / Unassigned" })).toHaveCount(0);
});

test("edits prepared releases, prevents duplicate preparation, links existing actions, and keeps terminal actions read-only", async ({ page }) => {
  const token = `S2B-REL-${Date.now()}`;
  const session = await createSession(page, token);
  const family = await createFamily(page, session.id, token);
  const passenger = await createPassenger(page, session.id, token);
  const match = await createMatch(page, session.id, family.id, passenger.id);
  await verifyMatch(page, match.id);

  await login(page);
  await useSession(page, session);
  await page.goto("/release-control");
  await page.getByRole("button", { name: "New" }).click();
  const createDrawer = page.getByRole("dialog", { name: "Prepare Action" });
  await createDrawer.getByLabel("Match").selectOption(match.id);
  const externalPrepared = await apiPost(page, "/releases", {
    sessionId: session.id,
    matchId: match.id,
    actionType: "Release",
    identityChecked: false,
    holdCleared: true
  });
  expect(externalPrepared.response.status()).toBe(201);
  await createDrawer.getByRole("button", { name: "Prepare action" }).click();
  await expect(createDrawer.getByText(new RegExp(`${externalPrepared.body.operationalId} is already the open release action`))).toBeVisible();
  await createDrawer.getByRole("button", { name: "Close" }).click();
  await page.getByRole("dialog", { name: "Discard unsaved changes?" }).getByRole("button", { name: "Discard changes" }).click();
  await page.reload();

  let card = page.locator("article").filter({ hasText: externalPrepared.body.operationalId });
  await expect(card.getByText("Identity pending")).toBeVisible();
  await expect(card.getByText("Receiving party missing")).toBeVisible();
  await expect(card.getByRole("button", { name: "Complete" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "View" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();

  await card.getByRole("button", { name: "Edit" }).click();
  const editDrawer = page.getByRole("dialog", { name: "Edit Prepared Action" });
  await editDrawer.getByLabel("Receiving party").fill("Authorized receiver");
  await editDrawer.getByLabel("Identity checked").check();
  await editDrawer.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(new RegExp(`${externalPrepared.body.operationalId} updated`))).toBeVisible();

  await page.getByRole("button", { name: "New" }).click();
  const duplicateDrawer = page.getByRole("dialog", { name: "Prepare Action" });
  await expect(duplicateDrawer.getByLabel("Match").getByRole("option", { name: new RegExp(match.operationalId) })).toHaveCount(0);
  await duplicateDrawer.getByRole("button", { name: "Close" }).click();

  await page.goto("/matching");
  await page.getByText(match.operationalId, { exact: true }).first().click();
  await page.getByRole("link", { name: "Open existing or prepare release action" }).click();
  await expect(page.getByRole("heading", { name: "View Release Action" })).toBeVisible();
  await expect(page.getByText(externalPrepared.body.operationalId, { exact: true }).first()).toBeVisible();
  await page.getByRole("dialog", { name: "View Release Action" }).getByRole("button", { name: "Close" }).click();

  card = page.locator("article").filter({ hasText: externalPrepared.body.operationalId });
  await expect(card.getByRole("button", { name: "Complete" })).toBeEnabled();
  await card.getByRole("button", { name: "Complete" }).click();
  await page.getByLabel("Decision note").fill("Identity, hold, receiver and transport checks completed.");
  await page.getByRole("button", { name: "Complete action" }).click();
  await expect(card.getByText("Completed", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "View" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Complete" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Cancel" })).toHaveCount(0);

  const replacement = await apiPost(page, "/releases", { sessionId: session.id, matchId: match.id, actionType: "Release", identityChecked: true, holdCleared: true, receivingParty: "Receiver" });
  expect(replacement.response.status()).toBe(201);
  await page.goto("/release-control");
  const replacementCard = page.locator("article").filter({ hasText: replacement.body.operationalId });
  await replacementCard.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Decision note").fill("Replacement action cancelled after operational review.");
  await page.getByRole("button", { name: "Cancel action" }).click();
  await expect(replacementCard.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(replacementCard.getByRole("button", { name: "Edit" })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(replacementCard.getByRole("button", { name: "View" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});

test("shows exact release blockers and rejects a stale edit after hold or terminal state changes", async ({ page }) => {
  const token = `S2B-BLOCK-${Date.now()}`;
  const session = await createSession(page, token);
  const family = await createFamily(page, session.id, token);
  const passenger = await createPassenger(page, session.id, token);
  const match = await createMatch(page, session.id, family.id, passenger.id);
  await verifyMatch(page, match.id);
  const prepared = await apiPost(page, "/releases", {
    sessionId: session.id,
    matchId: match.id,
    actionType: "Release",
    identityChecked: true,
    holdCleared: true,
    receivingParty: "Authorized receiver"
  });
  expect(prepared.response.status()).toBe(201);
  const held = await apiPost(page, `/matching-records/${match.id}/hold`, {
    decisionNotes: "Security review required before completion.",
    holdCheck: "Security hold"
  });
  expect(held.response.ok()).toBeTruthy();

  await login(page);
  await useSession(page, session);
  await page.goto("/release-control");
  let card = page.locator("article").filter({ hasText: prepared.body.operationalId });
  await expect(card.getByText("Active hold: Security hold")).toBeVisible();
  await expect(card.getByText("Match status: Hold / escalate")).toBeVisible();
  await expect(card.getByRole("button", { name: "Complete" })).toBeDisabled();

  await apiPost(page, `/matching-records/${match.id}/clear-hold`, { decisionNotes: "Security hold cleared." });
  await verifyMatch(page, match.id);
  await page.reload();
  card = page.locator("article").filter({ hasText: prepared.body.operationalId });
  await card.getByRole("button", { name: "Edit" }).click();
  const staleDrawer = page.getByRole("dialog", { name: "Edit Prepared Action" });
  await staleDrawer.getByLabel("Receiving party").fill("Changed receiver");
  const cancelled = await apiPost(page, `/releases/${prepared.body.id}/cancel`, { notes: "Action became terminal while the editor remained open." });
  expect(cancelled.response.ok()).toBeTruthy();
  await staleDrawer.getByRole("button", { name: "Save changes" }).click();
  await expect(staleDrawer.getByText("This release action is no longer prepared and cannot be edited.")).toBeVisible();
  await expect(staleDrawer).toBeVisible();
});

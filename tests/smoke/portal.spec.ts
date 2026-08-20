import { expect, test, type Page } from "@playwright/test";
import { clearAuthSession, completeDevelopmentLogin, login } from "./helpers";

const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4100)}/api`;
const coordinatorHeaders = { "content-type": "application/json", "x-user-email": "coordinator@lot.pl" };
const cleanupSessionIds: string[] = [];

type TestSession = { id: string; operationalId: string; mode: string; status: string; description?: string };

async function createSession(page: Page, token: string) {
  const response = await page.request.post(`${apiUrl}/sessions`, {
    headers: coordinatorHeaders,
    data: {
      mode: "EXERCISE",
      status: "Active",
      eventType: "Exercise",
      flightNumber: token,
      route: "WAW-S2E",
      airportLocation: "Stage 2E browser smoke",
      description: `Stage 2E active-event session ${token}`,
      startAt: "2026-07-02T08:00:00.000Z"
    }
  });
  expect(response.ok()).toBeTruthy();
  const session = (await response.json()) as TestSession;
  cleanupSessionIds.push(session.id);
  return session;
}

async function useSession(page: Page, session: TestSession) {
  await page.goto("/sessions");
  const row = page.getByRole("row").filter({ hasText: session.operationalId });
  await expect(row).toBeVisible();
  const action = row.getByRole("button", { name: "Use this session" });
  if (await action.count()) await action.click();
  await expect(page.locator(`[aria-label*="Current session EXERCISE ${session.operationalId}"]:visible`)).toHaveCount(1);
}

async function expectNoTechnicalStorageCopy(page: Page) {
  await expect(page.locator("body")).not.toContainText(/demo api|demo mode|in-memory|reset on restart|database not connected|source not connected|temporary storage|local development|database-backed|non-database|data-source|static sample/i);
}

test.afterEach(async ({ page }) => {
  for (const sessionId of cleanupSessionIds.splice(0)) {
    await page.request.post(`${apiUrl}/sessions/${sessionId}/close`, { headers: coordinatorHeaders, data: { notes: "Stage 2E smoke cleanup." } }).catch(() => undefined);
  }
});

test.describe("ZPP Connect portal", () => {
  test("shows the login page with assigned account guidance", async ({ page }) => {
    await clearAuthSession(page);
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "ZPP Connect" })).toBeVisible();
    await expect(page.getByText("Emergency Response Portal")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("Use your assigned ZPP Connect account")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Microsoft" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in with email" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Development access" })).toBeVisible();
    await expectNoTechnicalStorageCopy(page);
  });

  test("keeps product sign-in actions separate from local authentication", async ({ page }) => {
    await clearAuthSession(page);
    await page.getByRole("button", { name: "Continue with Microsoft" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText("Use Development access below to enter this workspace.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/authenticated|sso successful|password validated|reset email/i);

    await page.getByLabel("Work email").fill("admin@lot.pl");
    await page.getByRole("button", { name: "Check sign-in options" }).click();
    await expect(page.getByText("Microsoft and email sign-in are available for this account.")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Development access" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  });

  test("hides development account selection when development authentication is disabled", async ({ page }) => {
    await page.route("**/api/auth/config", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ developmentAccessEnabled: false }) });
    });
    await page.route("**/api/auth/development/users", async (route) => {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }) });
    });

    await clearAuthSession(page);
    await expect(page.getByRole("heading", { name: "Development access" })).toHaveCount(0);
    await expect(page.getByLabel("Account")).toHaveCount(0);
    await page.getByRole("button", { name: "Continue with Microsoft" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText("This sign-in method is not available yet.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/authenticated|sso successful|password validated|reset email/i);
  });

  test("restores a permitted route after login and clears access on logout", async ({ page }) => {
    await clearAuthSession(page);
    await page.goto("/training");
    await expect(page).toHaveURL(/\/login\?returnTo=/);
    await completeDevelopmentLogin(page, "volunteer@lot.pl", /\/training$/);

    await expect(page.getByRole("heading", { name: "Training", exact: true })).toBeVisible();
    await expect(page.locator("header select")).toHaveCount(0);
    const accountButton = page.getByRole("button", { name: "Account menu" });
    await expect(accountButton).toContainText("ZPP Member 01");
    await accountButton.click();
    const menu = page.getByRole("menu");
    await expect(menu).toContainText("ZPP Member 01");
    await expect(menu).toContainText("ZPP Member");
    await menu.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto("/training");
    await expect(page).toHaveURL(/\/login\?returnTo=/);
    await expect(page.getByText("Adam Dabrowski · ZPP-221")).toHaveCount(0);
  });

  test("logs in as ZPP Group Leader and shows only scoped operational navigation", async ({ page }) => {
    await login(page, "zpp@lot.pl");

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Case Work/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /TEC Intake/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Passenger \/ SRC/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Matching/ })).toHaveCount(0);
    await page.getByRole("button", { name: /People/ }).click();
    await expect(page.getByRole("link", { name: /Rostering/ }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Members/ }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Groups/ }).first()).toBeVisible();
  });

  test("shows operational session mode without technical data-source indicators", async ({ page }) => {
    await login(page, "zpp@lot.pl");

    await expect(page.locator('[aria-label^="Data source:"]:visible')).toHaveCount(0);
    await expect(page.locator('[aria-label^="Current session EXERCISE"]:visible')).toHaveCount(1);
    await expectNoTechnicalStorageCopy(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator('[aria-label^="Data source:"]:visible')).toHaveCount(0);
    await expect(page.locator('[aria-label^="Current session EXERCISE"]:visible')).toHaveCount(1);
    await expectNoTechnicalStorageCopy(page);
  });

  test("shows entity-derived notifications without technical implementation copy", async ({ page }) => {
    await login(page, "volunteer@lot.pl");

    await page.getByRole("button", { name: /unread notifications|Notifications/ }).click();
    const panel = page.getByRole("dialog", { name: "Notification center" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Action required", { exact: true })).toBeVisible();
    await expect(panel.getByText("Updates", { exact: true })).toBeVisible();
    await expect(panel.getByText("Assignment awaiting action").or(panel.getByText("Assignment overdue"))).toBeVisible();
    await expect(panel.getByText("Assignment assigned to you")).toBeVisible();
    await expect(panel).not.toContainText(/demo mode|demo api|in-memory|reset on restart|database not connected|source not connected|temporary storage|local development|data-source/i);
  });

  test("keeps notification read controls, read-all, action links and keyboard close usable", async ({ page }) => {
    await login(page, "volunteer@lot.pl");
    await page.getByRole("button", { name: /unread notifications|Notifications/ }).click();
    let panel = page.getByRole("dialog", { name: "Notification center" });
    let durableRow = panel.locator("article").filter({ hasText: "Training overdue" });
    await durableRow.getByRole("button", { name: "Mark read" }).click();
    await expect(durableRow.getByRole("button", { name: "Mark unread" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    await page.reload();
    await page.getByRole("button", { name: /unread notifications|Notifications/ }).click();
    panel = page.getByRole("dialog", { name: "Notification center" });
    durableRow = panel.locator("article").filter({ hasText: "Training overdue" });
    await expect(durableRow.getByRole("button", { name: "Mark unread" })).toBeVisible();
    await durableRow.getByRole("button", { name: "Mark unread" }).click();
    await expect(durableRow.getByRole("button", { name: "Mark read" })).toBeVisible();
    await panel.getByRole("button", { name: "Mark read", exact: true }).first().click();
    await expect(panel.locator("article").getByRole("button", { name: "Mark unread" }).first()).toBeVisible();
    await expect(panel.locator("article").getByRole("link").first()).toBeVisible();
  });

  test("does not show fallback notifications after the notifications API fails", async ({ page }) => {
    await page.route("**/api/notifications**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Notifications unavailable" }) });
        return;
      }
      await route.continue();
    });

    await login(page, "volunteer@lot.pl");
    await page.getByRole("button", { name: /Notifications|unread notifications/ }).click();
    const panel = page.getByRole("dialog", { name: "Notification center" });
    await expect(panel.getByText("Unable to load notifications.")).toBeVisible();
    await expect(panel.getByText("Assignment assigned to you")).toHaveCount(0);
    await expect(panel).not.toContainText(/demo mode|demo api|in-memory|reset on restart|database not connected|source not connected|temporary storage|local development|data-source/i);
  });

  test("uses a compact mobile navigation drawer", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await login(page, "admin@lot.pl");

    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
    await expect(page.getByRole("link", { name: /TEC Intake/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("button", { name: /Case Work/ })).toBeVisible();
    await page.getByRole("button", { name: /Case Work/ }).click();
    await page.getByRole("link", { name: /TEC Intake/ }).click();
    await expect(page).toHaveURL(/\/tec-intake$/);
  });

  test("renders all required System Admin routes", async ({ page }) => {
    await login(page, "admin@lot.pl");

    const routes = [
      ["/dashboard", "Dashboard"],
      ["/active-event", "Active Event"],
      ["/sessions", "Sessions"],
      ["/tec-intake", "TEC Intake"],
      ["/family-nok", "Family / NOK"],
      ["/passenger-src", "Passenger / SRC"],
      ["/matching", "Matching"],
      ["/release-control", "Release Control"],
      ["/requests", "Requests"],
      ["/timeline", "Timeline"],
      ["/members", "Members"],
      ["/rostering", "Rostering"],
      ["/assignments", "Assignments"],
      ["/training", "Training"],
      ["/documents", "Documents"],
      ["/readiness", "Readiness"],
      ["/files-import", "Files / Import"],
      ["/reports", "Reports"],
      ["/exercise", "Exercise"],
      ["/users-access", "Users & Access"],
      ["/roles-permissions", "Roles & Permissions"],
      ["/audit", "Audit"],
      ["/settings", "Settings"]
    ] as const;

    for (const [path, heading] of routes) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }

    await page.goto("/next-of-kin");
    await expect(page).toHaveURL(/\/family-nok$/);
    await expect(page.getByRole("heading", { name: "Family / NOK", exact: true })).toBeVisible();
  });

  test("shows access administration to System Admin users", async ({ page }) => {
    await login(page, "admin@lot.pl");

    await page.goto("/users-access");
    await expect(page.getByRole("heading", { name: "Users & Access", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Find accounts" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "User accounts" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
    await page.getByRole("button", { name: "Review" }).first().click();
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Roles", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Effective access", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Authentication policy", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Account lifecycle", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Access history", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Suspend" }).click();
    await expect(page.getByRole("heading", { name: "Suspend account" })).toBeVisible();
    await expect(page.getByText("Impact preview")).toBeVisible();
    await expect(page.getByRole("button", { name: "Suspend account" })).toBeEnabled();
    await page.getByRole("button", { name: "Suspend account" }).click();
    await expect(page.getByText("A reason is required.")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    const authPolicyCard = page.locator("section").filter({ has: page.getByRole("heading", { name: "Authentication policy", exact: true }) }).first();
    await authPolicyCard.getByLabel("Authentication policy").selectOption("PASSWORD_ONLY");
    await authPolicyCard.getByRole("button", { name: "Review policy change" }).click();
    await expect(page.getByRole("heading", { name: "Change authentication policy" })).toBeVisible();
    await page.getByRole("button", { name: "Apply policy" }).click();
    await expect(page.getByText("A reason is required.")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByRole("button", { name: /send invitation|resend invitation|revoke application sessions|reset password|set password|create password/i })).toHaveCount(0);
    await expect(page.getByRole("main")).not.toContainText(/invitation sent|copy invitation|temporary password|password reset|administrator password/i);
    await expectNoTechnicalStorageCopy(page);

    await page.goto("/roles-permissions");
    await expect(page.getByRole("heading", { name: "Roles & Permissions", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Role catalogue" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Create custom role" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("row").filter({ hasText: "System Admin" })).toBeVisible();
    await expectNoTechnicalStorageCopy(page);
  });

  test("prepares user invitations without credential or storage implementation copy", async ({ page }) => {
    await login(page, "admin@lot.pl");
    await page.goto("/users-access");

    await page.getByRole("button", { name: "Invitations" }).click();
    await expect(page.getByRole("heading", { name: "Invite user" })).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText(/temporary password|password reset|copy invitation|provider secret|provider subject|tenant id|email sent/i);
    await expectNoTechnicalStorageCopy(page);

    const token = Date.now();
    const displayName = `Smoke Invited User ${token}`;
    const loginIdentifier = `smoke.invited.${token}@lot.pl`;
    await page.getByLabel("Display name").fill(displayName);
    await page.getByLabel("Login identifier").fill(loginIdentifier);
    await page.getByLabel("Authentication policy", { exact: false }).first().selectOption("SSO_ONLY");
    await page.getByLabel("Department").fill("Training operations");
    await page.getByLabel("Role").selectOption("observer");
    await page.getByRole("button", { name: "Review invitation" }).click();

    await expect(page.getByRole("heading", { name: "Review invitation" })).toBeVisible();
    await expect(page.getByText(displayName)).toBeVisible();
    await expect(page.getByText(loginIdentifier)).toBeVisible();
    await expect(page.getByText("Observer · Global")).toBeVisible();
    await page.getByRole("button", { name: "Create invitation" }).click();

    await expect(page.getByText("Invitation prepared.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Invitations" })).toBeVisible();
    await expect(page.getByText(displayName)).toBeVisible();
    await expect(page.getByText(loginIdentifier)).toBeVisible();
    await expect(page.getByRole("main").getByText("Prepared", { exact: true }).last()).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText(/temporary password|password reset|copy invitation|provider secret|provider subject|tenant id|email sent/i);
    await expectNoTechnicalStorageCopy(page);
  });

  test("keeps access administration hidden from non-admin users", async ({ page }) => {
    await login(page, "volunteer@lot.pl");
    await expect(page.getByRole("link", { name: /Users & Access/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Roles & Permissions/ })).toHaveCount(0);
    await page.goto("/users-access");
    await expect(page.getByRole("heading", { name: "Limited Access", exact: true })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("Access is restricted for the active operational profile.");
    await expectNoTechnicalStorageCopy(page);
  });

  test("shows Active Event from the selected session with operational briefing content", async ({ page }) => {
    await login(page, "admin@lot.pl");

    await page.goto("/active-event");
    const seededMain = page.getByRole("main");
    await expect(seededMain.getByRole("heading", { name: "Current operational briefing" })).toBeVisible();
    await expect(seededMain.getByRole("heading", { name: "Confirmed information" })).toBeVisible();
    await expect(seededMain.getByRole("heading", { name: "Information to verify" })).toBeVisible();
    await expect(seededMain.getByRole("heading", { name: "Current priorities" })).toBeVisible();
    await expect(seededMain.getByText("Published revision 1")).toBeVisible();
    await expect(seededMain.getByRole("heading", { name: "Activated Functions" })).toHaveCount(0);
    await expectNoTechnicalStorageCopy(page);

    const first = await createSession(page, `S2E-A-${Date.now()}`);
    const second = await createSession(page, `S2E-B-${Date.now()}`);

    await useSession(page, first);
    await page.goto("/active-event");
    const activeEventMain = page.getByRole("main");
    await expect(activeEventMain.getByText(first.operationalId)).toBeVisible();
    await expect(activeEventMain.getByText(first.mode, { exact: true })).toBeVisible();
    await expect(activeEventMain.getByText(first.status, { exact: true })).toBeVisible();
    await expect(activeEventMain.getByText(first.description ?? "")).toBeVisible();
    await expect(activeEventMain.getByText("No published briefing")).toBeVisible();
    await expect(activeEventMain.getByRole("heading", { name: "Activated Functions" })).toHaveCount(0);
    await expect(page.getByText("Today 14:00")).toHaveCount(0);
    await expectNoTechnicalStorageCopy(page);

    await useSession(page, second);
    await page.goto("/active-event");
    await expect(page.getByRole("main").getByText(second.operationalId)).toBeVisible();
    await expect(page.getByRole("main").getByText(first.description ?? "")).toHaveCount(0);
  });

  test("shows a no-session Active Event state without inventing an incident", async ({ page }) => {
    await page.route("**/api/sessions**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 0, data: [] }) });
        return;
      }
      await route.continue();
    });

    await login(page, "admin@lot.pl");
    await page.goto("/active-event");

    await expect(page.getByText("No active session selected")).toBeVisible();
    await expect(page.getByText("Select an open session before using Active Event information for operational work.")).toBeVisible();
    await expect(page.getByText("ERP-2026-001")).toHaveCount(0);
    await expectNoTechnicalStorageCopy(page);
  });

  test("opens linked assignments from Active Event without task mutation controls", async ({ page }) => {
    await login(page, "admin@lot.pl");
    await page.goto("/active-event");

    await expect(page.getByRole("heading", { name: "Current priorities" })).toBeVisible();
    await expect(page.getByText("Linked task in progress").first()).toBeVisible();
    await expect(page.getByText("Linked task pending")).toBeVisible();
    await expect(page.getByRole("button", { name: /Claim|Reassign|Complete|Start/ })).toHaveCount(0);

    await page.getByRole("link", { name: "Open assignment" }).first().click();
    await expect(page).toHaveURL(/\/assignments\?assignmentId=asn-demo-3/);
    const drawer = page.getByRole("dialog", { name: /Assignment/i });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel(/Title/)).toHaveValue("Verify restricted case before first contact");
    await expectNoTechnicalStorageCopy(page);

    await clearAuthSession(page);
    await login(page, "viewer@lot.pl");
    await page.goto("/active-event");
    await expect(page.getByText("Assignment details restricted").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Open assignment" })).toHaveCount(0);
    await expectNoTechnicalStorageCopy(page);
  });

  test("does not replace an empty Groups API response with fallback groups", async ({ page }) => {
    await page.route("**/api/groups**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 0, data: [] }) });
        return;
      }
      await route.continue();
    });

    await login(page, "admin@lot.pl");
    await page.goto("/groups");

    await expect(page.getByText("No groups have been created")).toBeVisible();
    await expect(page.getByRole("main").getByText("Family Assistance Alpha")).toHaveCount(0);
    await expectNoTechnicalStorageCopy(page);
  });

  test("keeps the Groups drawer open and unsaved when the API save fails", async ({ page }) => {
    await page.route("**/api/groups/*", async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Stage 2E forced save failure" }) });
        return;
      }
      await route.continue();
    });

    await login(page, "admin@lot.pl");
    await page.goto("/groups");
    await page.getByRole("button", { name: /Edit Family Assistance Alpha/ }).click();
    const drawer = page.getByRole("dialog", { name: "Edit Group" });
    await expect(drawer).toBeVisible();
    await drawer.getByLabel("Notes").fill("This edit must not become a local success.");
    await drawer.getByRole("button", { name: "Save group" }).click();

    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("Stage 2E forced save failure")).toBeVisible();
  });

  test("shows Groups readiness distribution without averaged ready percentages", async ({ page }) => {
    let readinessRequests = 0;
    await page.route("**/api/readiness/groups**", async (route) => {
      if (route.request().method() === "GET") readinessRequests += 1;
      await route.continue();
    });

    await login(page, "admin@lot.pl");
    await page.goto("/groups");

    await expect(page.getByRole("heading", { name: "Groups", exact: true })).toBeVisible();
    await expect(page.getByText("Family Assistance Alpha")).toBeVisible();
    await expect(page.locator("body")).toContainText(/Ready with attention|Not ready|Ready|Unable to determine|Not applicable/);
    await expect(page.locator("body")).not.toContainText(/% ready|\d+%|readiness score/i);
    expect(readinessRequests).toBeLessThanOrEqual(2);

    await page.getByRole("button", { name: /Edit Family Assistance Alpha/ }).click();
    const drawer = page.getByRole("dialog", { name: "Edit Group" });
    await expect(drawer).toBeVisible();
    await expect(drawer).not.toContainText(/% ready|\d+%|readiness score/i);
    await expectNoTechnicalStorageCopy(page);
  });

  test("labels imports and unsupported report formats without technical storage copy", async ({ page }) => {
    await login(page, "admin@lot.pl");

    await page.goto("/files-import");
    await expect(page.getByText("Upload the file for validation")).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload and validate" })).toBeDisabled();
    await expectNoTechnicalStorageCopy(page);

    await page.goto("/reports");
    const main = page.getByRole("main");
    await expect(main.getByText("CSV export for authorized operational use").first()).toBeVisible();
    await expect(main.getByText("This report format is not available right now").first()).toBeVisible();
    await expect(main.getByRole("button", { name: "Unavailable" }).first()).toBeDisabled();
    await expectNoTechnicalStorageCopy(page);
  });

  test("keeps TEC and SRC record forms available in the new shell", async ({ page }) => {
    await login(page, "tec@lot.pl");
    await page.goto("/tec-intake");
    await expect(page.getByRole("heading", { name: "TEC Intake", exact: true })).toBeVisible();
    await expect(page.getByText("TEC-2026-000001")).toBeVisible();
    await page.getByRole("button", { name: "New" }).click();
    await expect(page.getByRole("heading", { name: "New TEC enquiry" })).toBeVisible();
    await expect(page.getByText("Caller name")).toBeVisible();

    await clearAuthSession(page);
    await login(page, "admin@lot.pl");
    await page.goto("/passenger-src");
    await expect(page.getByRole("heading", { name: "Passenger / SRC", exact: true })).toBeVisible();
    await expect(page.getByText("PAX-2026-000001")).toBeVisible();
    await page.getByRole("button", { name: "Edit" }).first().click();
    await expect(page.getByRole("heading", { name: "Edit passenger/SRC record" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark SRC confirmed" })).toBeVisible();
  });

  test("supports rostering filters for ZPP Group Leaders", async ({ page }) => {
    await login(page, "zpp@lot.pl");
    await page.goto("/rostering");

    await expect(page.getByRole("heading", { name: "Rostering" })).toBeVisible();
    await expect(page.getByText("Family Assistance Centre morning support")).toBeVisible();
    await expect(page.getByText("RST-006")).toHaveCount(0);
    await expect(page.getByText("Airport Reception Support cover")).toHaveCount(0);
    await expect(page.getByText("Telephone Enquiry Center evening supervisor")).toHaveCount(0);
    await expect(page.getByLabel("Group", { exact: true }).locator("option")).toHaveText(["All groups", "Family Assistance Alpha"]);

    await page.getByRole("button", { name: "New shift" }).click();
    const drawer = page.getByRole("dialog", { name: "New roster shift" });
    await expect(drawer).toBeVisible();
    const token = `Smoke roster ${Date.now()}`;
    await drawer.getByLabel("Title").fill(token);
    await drawer.getByLabel("Function").fill("Welfare Support");
    await drawer.getByLabel("Duty").fill("Coverage check");
    await drawer.getByLabel("Start").fill("2026-07-18T08:00");
    await drawer.getByLabel("End").fill("2026-07-18T12:00");
    await drawer.getByLabel("Group").selectOption({ label: "Family Assistance Alpha" });
    await drawer.getByRole("button", { name: "Create shift" }).click();
    await expect(page.getByText("Roster shift created")).toBeVisible();
    await expect(page.getByRole("dialog").getByText(token)).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Publish" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/readiness score|\d+%|% ready|Risk first/i);
    await expectNoTechnicalStorageCopy(page);
  });

  test("shows Rostering readiness as informational status without legacy scores", async ({ page }) => {
    let readinessRequests = 0;
    await page.route("**/api/readiness/members**", async (route) => {
      if (route.request().method() === "GET") readinessRequests += 1;
      await route.continue();
    });

    await login(page, "admin@lot.pl");
    await page.goto("/rostering");

    await expect(page.getByRole("heading", { name: "Rostering" })).toBeVisible();
    await expect(page.getByText("Family Assistance Centre morning support")).toBeVisible();
    await expect(page.locator("main")).toContainText(/Ready with attention|Not ready|Ready|Unable to determine|Not applicable/);
    await expect(page.locator("body")).not.toContainText(/readiness score|\d+%|% ready|restricted-ready|Ready for restricted|Risk first/i);
    await page.getByRole("button", { name: "New shift" }).click();
    await expect(page.getByRole("dialog", { name: "New roster shift" }).getByLabel("Assigned member")).toContainText("Magdalena Jankowska");
    expect(readinessRequests).toBeLessThan(5);
    await expectNoTechnicalStorageCopy(page);
  });

  test("keeps Rostering usable when Readiness status is unavailable", async ({ page }) => {
    await page.route("**/api/readiness/members**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Readiness status unavailable" }) });
        return;
      }
      await route.continue();
    });

    await login(page, "admin@lot.pl");
    await page.goto("/rostering");

    await expect(page.getByText("Readiness status could not be loaded. Roster shifts remain available.")).toBeVisible();
    await expect(page.getByText("Family Assistance Centre morning support")).toBeVisible();
    await expect(page.locator("main")).toContainText("Unable to determine");
    await expect(page.locator("body")).not.toContainText(/readiness score|\d+%|% ready|restricted-ready/i);
    await expectNoTechnicalStorageCopy(page);
  });

  test("keeps Rostering on API errors without showing fallback shifts", async ({ page }) => {
    await page.route("**/api/roster-shifts**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Roster service unavailable" }) });
        return;
      }
      await route.continue();
    });

    await login(page, "zpp@lot.pl");
    await page.goto("/rostering");

    await expect(page.getByText("Roster service unavailable")).toBeVisible();
    await expect(page.getByRole("main").getByText("Family Assistance Centre morning support")).toHaveCount(0);
    await expectNoTechnicalStorageCopy(page);
  });

  test("filters and updates the member directory through the API", async ({ page }) => {
    await login(page, "admin@lot.pl");
    await page.goto("/members");

    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await expect(page.getByText("ZPP members", { exact: true })).toBeVisible();
    await expect(page.getByText("TEC agents", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /TEC/ }).click();
    await page.getByLabel("Search members").fill("TEC-001");
    await expect(page.getByText("TEC-001")).toBeVisible();

    await page.getByRole("button", { name: /All/ }).click();
    await page.getByLabel("Search members").fill("ZPP-001");
    await expect(page.getByText("ZPP-001")).toBeVisible();
    await expect(page.getByText("1-1 of 1")).toBeVisible();

    await page.getByRole("button", { name: "Edit" }).click();
    const drawer = page.getByRole("dialog", { name: "Edit Member" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("Readiness score")).toHaveCount(0);
    const lastName = `Smoke${Date.now()}`;
    await drawer.getByLabel("First name").fill("Marta");
    await drawer.getByLabel("Last name").fill(lastName);
    await drawer.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Member updated")).toBeVisible();
    await expect(page.getByText(`Marta ${lastName}`)).toBeVisible();
    await page.reload();
    await expect(page.getByText(`Marta ${lastName}`)).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/readiness score|\d+%|restricted-ready|Ready for restricted|Risk first/i);
    await expectNoTechnicalStorageCopy(page);
  });

  test("shows Members readiness from the Readiness API without legacy percentages", async ({ page }) => {
    let readinessRequests = 0;
    await page.route("**/api/readiness/members**", async (route) => {
      if (route.request().method() === "GET") readinessRequests += 1;
      await route.continue();
    });

    await login(page, "admin@lot.pl");
    await page.goto("/members");

    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await expect(page.getByText("Readiness attention", { exact: true })).toBeVisible();
    await expect(page.locator("body")).toContainText(/Ready with attention|Not ready|Ready|Unable to determine|Not applicable/);
    await expect(page.locator("body")).not.toContainText(/readiness score|\d+%|restricted-ready|Ready for restricted|Risk first/i);
    expect(readinessRequests).toBeLessThanOrEqual(2);
    await expectNoTechnicalStorageCopy(page);
  });

  test("keeps Members readable when Readiness status is unavailable", async ({ page }) => {
    await page.route("**/api/readiness/members**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Readiness status unavailable" }) });
        return;
      }
      await route.continue();
    });

    await login(page, "admin@lot.pl");
    await page.goto("/members");

    await expect(page.getByText("Readiness status could not be loaded. Member profiles remain available.")).toBeVisible();
    await expect(page.getByText("Adam Dabrowski")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/readiness score|\d+%|restricted-ready/i);
    await expectNoTechnicalStorageCopy(page);
  });

  test("creates, assigns and completes operational assignments", async ({ page }) => {
    await login(page, "zpp@lot.pl");
    await page.goto("/assignments");

    await expect(page.getByRole("heading", { name: "Assignments", exact: true })).toBeVisible();
    await expect(page.getByText("Prepare welfare room briefing note")).toBeVisible();

    const title = `Smoke assignment ${Date.now()}`;
    await page.getByRole("button", { name: "New" }).click();
    await expect(page.getByRole("heading", { name: "New Assignment" })).toBeVisible();
    const drawer = page.getByRole("dialog", { name: "New Assignment" });
    await drawer.getByLabel("Title").fill(title);
    await drawer.getByLabel("Priority").selectOption("Urgent");
    await drawer.getByLabel("Function").selectOption("Rostering");
    await drawer.getByLabel("Linked record").fill("RST-SMOKE");
    await drawer.getByRole("button", { name: "Create assignment" }).click();

    const queueRow = page.getByRole("row").filter({ hasText: title });
    await expect(queueRow).toBeVisible();
    await expect(queueRow).toContainText("Open");

    await queueRow.getByRole("button", { name: "Claim", exact: true }).click();
    await expect(queueRow).toContainText("Open");
    await expect(queueRow).toContainText("ZPP Group Leader");
    await queueRow.getByRole("button", { name: "Start" }).click();
    await expect(queueRow).toContainText("In Progress");
    await expect(queueRow).toContainText("ZPP Group Leader");

    await page.getByRole("button", { name: "Assigned to me" }).click();
    await expect(page.getByLabel("Owner filter")).toHaveValue("__mine__");
    await expect(queueRow).toBeVisible();

    await queueRow.getByRole("button", { name: "Complete" }).click();
    await page.getByRole("dialog", { name: "Complete assignment?" }).getByRole("button", { name: "Complete assignment" }).click();
    await expect(queueRow).toContainText("Completed");

    await page.getByRole("button", { name: "Board" }).click();
    await expect(page.locator('[data-assignment-status="Completed"]').locator("article").filter({ hasText: title })).toBeVisible();
  });

  test("shows role-specific rostering views for Member and Observer", async ({ page }) => {
    await login(page, "volunteer@lot.pl");
    await page.goto("/rostering");
    await expect(page.getByText("Review your roster and confirm your own shifts when action is available.")).toBeVisible();
    await expect(page.getByText("Documentation Cell afternoon support")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New shift" })).toHaveCount(0);
    await expectNoTechnicalStorageCopy(page);

    await clearAuthSession(page);
    await login(page, "viewer@lot.pl");
    await page.goto("/rostering");
    await expect(page.getByRole("heading", { name: "Rostering" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Roster table" })).toBeVisible();
    await expect(page.getByText("Family Assistance Centre morning support")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New shift" })).toHaveCount(0);
    await expectNoTechnicalStorageCopy(page);
  });

  test("shows personal training with real actions for a linked Member", async ({ page }) => {
    await login(page, "volunteer@lot.pl");
    await page.goto("/training");

    await expect(page.getByRole("heading", { name: "Training", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "My training" })).toBeVisible();
    await expect(page.getByText("Adam Dabrowski · ZPP-221")).toBeVisible();
    await expect(page.getByText("Data Protection for Crisis Response")).toBeVisible();
    await expect(page.getByRole("button", { name: "New course" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Assign training" })).toHaveCount(0);

    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.getByText("Training started")).toBeVisible();
    await page.getByRole("button", { name: "Complete" }).first().click();
    const drawer = page.getByRole("dialog", { name: "Record completion" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Record completion" }).click();
    await expect(page.getByText("Completion recorded")).toBeVisible();
    await expectNoTechnicalStorageCopy(page);
  });

  test("shows TEC-related personal training for TEC identity", async ({ page }) => {
    await login(page, "tec@lot.pl");
    await page.goto("/training");

    await expect(page.getByText("Piotr Nowak · TEC-001")).toBeVisible();
    await expect(page.getByText("Telephone Enquiry Center Procedures")).toBeVisible();
    await expect(page.getByRole("button", { name: "New course" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Assign training" })).toHaveCount(0);
    await expectNoTechnicalStorageCopy(page);
  });

  test("lets System Admin manage training courses through the API-backed page", async ({ page }) => {
    await login(page, "admin@lot.pl");
    await page.goto("/training");

    await expect(page.getByRole("heading", { name: "Training", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Training Records" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New course" })).toBeVisible();

    const code = `SMOKE-${Date.now()}`;
    await page.getByRole("button", { name: "New course" }).click();
    const drawer = page.getByRole("dialog", { name: "New course" });
    await expect(drawer).toBeVisible();
    await drawer.getByLabel("Code").fill(code);
    await drawer.getByLabel("Title").fill("Smoke Training Course");
    await drawer.getByLabel("Category").fill("Coordination");
    await drawer.getByLabel("Delivery type").selectOption("Briefing");
    await drawer.getByRole("button", { name: "Save course" }).click();

    await expect(page.getByText("Course created")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Smoke Training Course" })).toBeVisible();

    await page.getByRole("button", { name: "Assign training" }).click();
    const assignDrawer = page.getByRole("dialog", { name: "Assign training" });
    await expect(assignDrawer).toBeVisible();
    await assignDrawer.getByLabel("Assign to").selectOption("Group");
    await assignDrawer.getByRole("combobox", { name: /^Group/ }).selectOption({ index: 1 });
    await assignDrawer.getByLabel("Course").selectOption({ label: "Smoke Training Course" });
    await assignDrawer.getByRole("button", { name: "Assign training" }).click();

    await expect(page.getByText(/Training assigned to \d+ group member/)).toBeVisible();
    await page.getByLabel("Search").fill("Smoke Training Course");
    await expect(page.getByRole("row").filter({ hasText: "Smoke Training Course" }).first()).toBeVisible();
    await expectNoTechnicalStorageCopy(page);
  });

  test("shows personal documents from the API and records acknowledgement", async ({ page }) => {
    await login(page, "volunteer@lot.pl");
    await page.goto("/documents");

    await expect(page.getByRole("heading", { name: "Documents", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "My documents" })).toBeVisible();
    await expect(page.getByText("Adam Dabrowski · ZPP-221")).toBeVisible();

    await page.getByLabel("Search my documents").fill("ERP Role Cards");
    const documentCard = page.getByRole("main").locator("div").filter({ hasText: "ERP Role Cards" }).filter({ hasText: "ERP-ROLE-CARDS" }).first();
    await expect(documentCard).toBeVisible();
    await documentCard.getByRole("button", { name: "Read" }).click();

    const drawer = page.getByRole("dialog", { name: "Document content" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("Use these role cards")).toBeVisible();
    await drawer.getByRole("button", { name: "Acknowledge" }).click();

    await expect(page.getByText("Document acknowledged")).toBeVisible();
    await expect(page.getByText("Acknowledged:")).toBeVisible();
    await expectNoTechnicalStorageCopy(page);
  });

  test("does not replace an empty Documents API response with fallback documents", async ({ page }) => {
    await page.route("**/api/documents**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ total: 0, data: [], totals: { documents: 0, published: 0, activeRequirements: 0, outstanding: 0 } })
        });
        return;
      }
      await route.continue();
    });
    await page.route("**/api/document-requirements**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 0, data: [] }) });
        return;
      }
      await route.continue();
    });
    await page.route("**/api/document-acknowledgements**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 0, data: [] }) });
        return;
      }
      await route.continue();
    });

    await login(page, "admin@lot.pl");
    await page.goto("/documents");

    await expect(page.getByRole("heading", { name: "Documents", exact: true })).toBeVisible();
    await expect(page.getByText("No documents found")).toBeVisible();
    await expect(page.getByRole("main").getByText("ERP Role Cards")).toHaveCount(0);
    await expect(page.getByRole("main").getByText("TEC Call Intake Guide")).toHaveCount(0);
    await expectNoTechnicalStorageCopy(page);
  });

  test("keeps Training on API errors without showing static module fallback", async ({ page }) => {
    await page.route("**/api/training/records**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Training service unavailable" }) });
        return;
      }
      await route.continue();
    });

    await login(page, "admin@lot.pl");
    await page.goto("/training");

    await expect(page.getByText("Training service unavailable")).toBeVisible();
    await expect(page.getByRole("main").getByText("ERP Familiarization")).toHaveCount(0);
    await expect(page.getByRole("main").getByText("Telephone Enquiry Center Procedures")).toHaveCount(0);
    await expectNoTechnicalStorageCopy(page);
  });

  test("shows API-backed readiness without static scores or fallback records", async ({ page }) => {
    await login(page, "volunteer@lot.pl");
    await page.goto("/readiness");

    await expect(page.getByRole("heading", { name: "Readiness", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "My readiness" })).toBeVisible();
    await expect(page.getByText("Adam Dabrowski · ZPP-221")).toBeVisible();
    await expect(page.getByText("Next actions")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/readiness score|\d+% ready/i);
    await expectNoTechnicalStorageCopy(page);

    await clearAuthSession(page);
    await login(page, "admin@lot.pl");
    await page.goto("/readiness");
    await expect(page.getByRole("heading", { name: "Readiness management" })).toBeVisible();
    await expect(page.getByRole("main").getByText("Adam Dabrowski")).toBeVisible();
    await page.getByRole("button", { name: "View" }).first().click();
    const readinessDrawer = page.getByRole("dialog");
    await expect(readinessDrawer).toBeVisible();
    await expect(readinessDrawer.getByText("Calculated")).toBeVisible();
    await expectNoTechnicalStorageCopy(page);
  });

  test("keeps Readiness on API errors without showing static module fallback", async ({ page }) => {
    await page.route("**/api/readiness/members**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Readiness service unavailable" }) });
        return;
      }
      await route.continue();
    });

    await login(page, "admin@lot.pl");
    await page.goto("/readiness");

    await expect(page.getByText("Readiness service unavailable")).toBeVisible();
    await expect(page.getByRole("main").getByText("Adam Dabrowski")).toHaveCount(0);
    await expect(page.getByRole("main").getByText("Anna Kowalska")).toHaveCount(0);
    await expectNoTechnicalStorageCopy(page);
  });

  test("keeps technical storage wording out of production-facing modules", async ({ page }) => {
    await login(page, "admin@lot.pl");
    for (const route of ["/dashboard", "/members", "/groups", "/rostering", "/training", "/readiness", "/active-event", "/settings"]) {
      await page.goto(route);
      await expectNoTechnicalStorageCopy(page);
    }
  });
});

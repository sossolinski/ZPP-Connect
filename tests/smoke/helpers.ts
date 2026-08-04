import { expect, type Page } from "@playwright/test";

export async function clearAuthSession(page: Page) {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto("about:blank");
  await page.goto("/login", { waitUntil: "domcontentloaded" });
}

export async function completeDevelopmentLogin(page: Page, email = "admin@lot.pl", expectedUrl: RegExp = /\/dashboard$/) {
  const accountSelect = page.getByLabel("Account");
  await expect(accountSelect).toBeVisible();
  const value = await accountSelect.locator("option").evaluateAll((options, expectedEmail) => {
    const normalized = String(expectedEmail).toLowerCase();
    return options
      .map((option) => ({ value: (option as HTMLOptionElement).value, text: option.textContent?.toLowerCase() ?? "" }))
      .find((option) => {
        const start = option.text.lastIndexOf(normalized);
        const exactSuffix = start >= 0 && start + normalized.length === option.text.length;
        const boundary = start === 0 || !/[a-z0-9_-]/.test(option.text[start - 1] ?? "");
        return exactSuffix && boundary;
      })?.value;
  }, email);
  expect(value, `Development account for ${email} should be available`).toBeTruthy();
  await accountSelect.selectOption(value!);

  const methodSelect = page.getByLabel("Sign-in method");
  if (await methodSelect.isVisible()) {
    const availableMethods = await methodSelect.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    await methodSelect.selectOption(availableMethods.includes("MICROSOFT_SSO") ? "MICROSOFT_SSO" : availableMethods[0]);
  }

  await page.getByRole("button", { name: "Enter ZPP Connect" }).click();
  await expect(page).toHaveURL(expectedUrl);
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        token: Boolean(localStorage.getItem("zpp:sessionToken")),
        user: Boolean(localStorage.getItem("zpp-connect:authenticated-user"))
      }))
    )
    .toEqual({ token: true, user: true });
}

export async function login(page: Page, email = "admin@lot.pl") {
  await clearAuthSession(page);
  await completeDevelopmentLogin(page, email);
}

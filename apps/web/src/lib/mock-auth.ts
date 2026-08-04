import type { UserContext } from "./types";
import type { DemoUser } from "./portal-types";

const sessionKey = "zpp-connect:authenticated-user";

export function userContextToPortalUser(user: UserContext): DemoUser {
  const roleSummary = user.roleLabels?.length ? user.roleLabels : user.roles;
  return {
    email: user.email,
    apiEmail: user.email,
    displayName: user.displayName,
    role: roleSummary[0] ?? "ZPP Member",
    roles: roleSummary,
    accessLevel: roleSummary.join(" + ") || "Operational access",
    authMethod: "Corporate SSO"
  };
}

export function storeAuthenticatedUser(user: UserContext) {
  const portalUser = userContextToPortalUser(user);
  localStorage.setItem(sessionKey, JSON.stringify(portalUser));
  return portalUser;
}

export function getStoredUser() {
  const stored = localStorage.getItem(sessionKey);
  if (!stored) return undefined;
  try {
    const parsed = JSON.parse(stored) as DemoUser;
    return parsed?.email && parsed?.displayName ? parsed : undefined;
  } catch {
    localStorage.removeItem(sessionKey);
    return undefined;
  }
}

export function clearStoredAuth() {
  localStorage.removeItem(sessionKey);
}

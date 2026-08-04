import type { Request } from "express";
import { hasPermission } from "./rbac.js";

const directSensitiveFields = new Set([
  "callerPhone",
  "callerEmail",
  "phone",
  "email",
  "pnr",
  "ticketNumber",
  "conditionStatus",
  "verificationNotes",
  "decisionNotes",
  "notes",
  "immediateNeeds"
]);

function canSeeSensitive(req: Request) {
  return (
    hasPermission(req, "family:update") ||
    hasPermission(req, "passenger:update") ||
    hasPermission(req, "matching:verify")
  );
}

export function redactForUser<T>(req: Request, value: T): T {
  if (canSeeSensitive(req)) return value;
  if (Array.isArray(value)) return value.map((item) => redactForUser(req, item)) as T;
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of Object.keys(output)) {
    if (directSensitiveFields.has(key)) {
      output[key] = "[restricted]";
    } else if (typeof output[key] === "object") {
      output[key] = redactForUser(req, output[key]);
    }
  }
  return output as T;
}

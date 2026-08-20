import type { NotificationInput } from "./notification-types.js";

const allowedRoutes = new Set(["/active-event", "/sessions", "/assignments", "/rostering", "/training", "/documents", "/settings"]);
const forbiddenCopy = /password|token|secret|passport|date of birth|phone|email address|medical|identity document|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\+\d[\d\s().-]{7,}\d|\b\d{9,15}\b|(?<![-A-Z])\d{3}-\d{3}-\d{3}(?![-A-Z])/i;

function safeText(value: string, label: string, max: number) {
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || text.length > max || forbiddenCopy.test(text)) throw new Error(`Unsafe notification ${label}`);
  return text;
}

export function safeNotificationInput(input: NotificationInput): NotificationInput {
  const route = input.actionDestination?.split("?")[0] ?? null;
  if (input.actionDestination && (!route || !allowedRoutes.has(route) || !input.actionDestination.startsWith("/") || input.actionDestination.startsWith("//"))) throw new Error("Unsafe notification action destination");
  const metadata = Object.fromEntries(Object.entries(input.metadata ?? {}).filter(([key, value]) => ["condition", "conditionType", "priority", "status", "operation", "version", "provenance"].includes(key) && ["string", "number", "boolean"].includes(typeof value)));
  return { ...input, title: safeText(input.title, "title", 180), message: safeText(input.message, "message", 500), sourceLabel: input.sourceLabel ? safeText(input.sourceLabel, "source label", 180) : null, sessionLabel: input.sessionLabel ? safeText(input.sessionLabel, "session label", 120) : null, actionLabel: input.actionLabel ? safeText(input.actionLabel, "action label", 80) : null, metadata };
}

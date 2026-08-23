import { randomUUID } from "node:crypto";

type DevelopmentSession = { id: string; token: string; userId: string; authenticationMethod: string; createdAt: string; revokedAt?: string };
const sessions = new Map<string, DevelopmentSession>();

export function createDevelopmentSession(userId: string, authenticationMethod = "DEVELOPMENT_HEADER") {
  const token = randomUUID();
  const session = { id: randomUUID(), token, userId, authenticationMethod, createdAt: new Date().toISOString() };
  sessions.set(token, session);
  return session;
}

export function developmentSession(token: string) {
  const session = sessions.get(token);
  return session && !session.revokedAt ? session : undefined;
}

export function revokeDevelopmentSession(token: string) {
  const session = sessions.get(token);
  if (session && !session.revokedAt) session.revokedAt = new Date().toISOString();
}

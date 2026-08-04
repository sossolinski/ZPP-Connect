import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

type AuditInput = {
  action: string;
  entityType?: string;
  entityId?: string;
  sessionId?: string | null;
  summary: string;
  metadata?: unknown;
};

export async function logAudit(req: Request, input: AuditInput) {
  await prisma.auditLog.create({
    data: {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      sessionId: input.sessionId ?? undefined,
      actorId: req.user?.id,
      actorEmail: req.user?.email,
      summary: input.summary,
      metadata: input.metadata === undefined || input.metadata === null ? undefined : (input.metadata as Prisma.InputJsonValue),
      ipAddress: req.ip,
      userAgent: req.header("user-agent")
    }
  });
}

export async function addTimelineEvent(input: {
  sessionId: string;
  caseId?: string | null;
  eventType: string;
  entityType?: string;
  entityId?: string;
  title: string;
  body?: string;
  metadata?: unknown;
  createdById?: string;
}) {
  await prisma.caseTimelineEvent.create({
    data: {
      sessionId: input.sessionId,
      caseId: input.caseId ?? undefined,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      title: input.title,
      body: input.body,
      metadata: input.metadata === undefined || input.metadata === null ? undefined : (input.metadata as Prisma.InputJsonValue),
      createdById: input.createdById
    }
  });
}

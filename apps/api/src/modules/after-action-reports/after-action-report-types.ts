import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

export const aarPdfLimit = 10 * 1024 * 1024;
export const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const expectedVersion = z.number().int().positive();
export const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).strict();
export const listSchema = pageSchema.extend({ sessionId: uuid, status: z.enum(["Active", "Archived"]).optional(), search: z.string().trim().max(200).optional() });
export const commandSchema = z.object({ operationId: uuid, expectedVersion }).strict();
export const archiveSchema = commandSchema.extend({ reason: text(2000) });
export const createSchema = z.object({
  operationId: uuid, sessionId: uuid, title: text(500),
  eventDate: z.string().datetime({ offset: true }).optional(),
  sourceObservationIds: z.array(uuid).max(100).default([]),
}).strict();
export const editSchema = z.object({
  expectedVersion, title: text(500), eventDate: z.string().datetime({ offset: true }),
  executiveSummary: z.string().trim().max(50000),
  findings: z.array(z.object({ id: uuid.optional(), area: text(200), summary: text(10000), detail: optionalText(10000) }).strict()).max(100),
  lessons: z.array(z.object({ statement: text(10000) }).strict()).max(100),
  correctiveActions: z.array(z.object({ recommendation: text(10000), owner: optionalText(200), targetDate: z.string().datetime({ offset: true }).nullable().optional() }).strict()).max(100),
  sourceObservationIds: z.array(uuid).max(100).default([]),
}).strict();
export type AarActor = { id: string; email: string; displayName: string; requestId?: string };
export type AarPage = z.infer<typeof pageSchema>;
export type AarCommand = z.infer<typeof commandSchema>;
export const versionInclude = {
  findings: { orderBy: { sortOrder: "asc" as const } },
  lessons: { orderBy: { sortOrder: "asc" as const } },
  correctiveActions: { orderBy: { sortOrder: "asc" as const } },
  createdBy: { select: { id: true, displayName: true } },
  submittedBy: { select: { id: true, displayName: true } },
  approvedBy: { select: { id: true, displayName: true } },
} satisfies Prisma.AfterActionReportVersionInclude;
export type AarVersion = Prisma.AfterActionReportVersionGetPayload<{ include: typeof versionInclude }>;
// Explicit select is shared by EVERY metadata/list query. Never load BYTEA there.
export const artifactSelect = {
  id: true, operationId: true, reportVersionId: true, sourceContentSha256: true,
  rendererVersion: true, fileName: true, mimeType: true, contentSizeBytes: true,
  contentSha256: true, storageProvider: true, storageKey: true, generatedAt: true,
  generatedById: true, generatedBy: { select: { id: true, displayName: true } }, requestId: true, status: true,
} satisfies Prisma.AfterActionPdfArtifactSelect;
export function sha256(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
export function canonicalJson(value: unknown): string {
  function stable(item: unknown): unknown {
    if (item instanceof Date) return item.toISOString();
    if (Array.isArray(item)) return item.map(stable);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v)]));
    return item;
  }
  return JSON.stringify(stable(value));
}
export function logicalContent(row: AarVersion) {
  return {
    schemaVersion: row.schemaVersion, reportId: row.reportId, revision: row.revision,
    basedOnVersionId: row.basedOnVersionId, title: row.title, eventDate: row.eventDate,
    executiveSummary: row.executiveSummary, contextSnapshot: row.contextSnapshot,
    createdById: row.createdById, createdAt: row.createdAt,
    submittedById: row.submittedById, submittedAt: row.submittedAt,
    approvedById: row.approvedById, approvedAt: row.approvedAt,
    findings: row.findings.map(({ sortOrder, area, summary, detail, sourceObservationId, sourceObservationVersion, sourceObservationOperationalId }) => ({ sortOrder, area, summary, detail, sourceObservationId, sourceObservationVersion, sourceObservationOperationalId })),
    lessons: row.lessons.map(({ sortOrder, statement }) => ({ sortOrder, statement })),
    correctiveActions: row.correctiveActions.map(({ sortOrder, recommendation, owner, targetDate }) => ({ sortOrder, recommendation, owner, targetDate })),
  };
}
export function contentDigest(row: AarVersion) { return sha256(canonicalJson(logicalContent(row))); }

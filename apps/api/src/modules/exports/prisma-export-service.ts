import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Permission } from "@zpp/shared";
import { HttpError } from "../../errors.js";
import { EffectiveAccessService } from "../identity/effective-access-service.js";
import {
  exportByteLimit,
  exportDefinitions,
  exportFormat,
  exportPageSize,
  exportRowLimit,
  exportSchemaVersion,
  generationPermissions,
  isDatasetExportType,
  isFoundationExportType,
  supportedExportTypes,
  type ExportActor,
  type ExportAuthorizationContext,
  type ExportFailureHooks,
  type ExportPreparationInput,
  type FoundationExportType
} from "./export-types.js";
import { serializeCsvSections, type CsvColumn, type CsvSection } from "./safe-csv.js";

type Db = PrismaClient | Prisma.TransactionClient;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminalRequestStatuses = ["RESOLVED", "CANCELLED"];

const columns = {
  Session: ["operationalId", "mode", "status", "eventType", "flightNumber", "route", "startedAt", "endedAt"],
  Enquiries: ["operationalId", "caseId", "contactChannel", "callerName", "callerPhone", "callerEmail", "callerLocation", "preferredLanguage", "claimedRelationship", "passengerName", "enquiryType", "urgency", "status", "notes", "createdAt", "updatedAt"],
  FamilyRecords: ["operationalId", "caseId", "familyName", "claimedRelationship", "phone", "email", "preferredContactChannel", "preferredLanguage", "verificationStatus", "verifiedRelationship", "verificationDecisionBy", "verificationDecisionAt", "verificationNotes", "immediateNeeds", "createdAt", "updatedAt"],
  PassengerRecords: ["operationalId", "caseId", "personType", "passengerName", "dateOfBirth", "age", "gender", "nationality", "flightNumber", "route", "seat", "pnr", "ticketNumber", "manifestVersion", "source", "conditionStatus", "holdStatus", "travellingCompanions", "notes", "createdAt", "updatedAt"],
  MatchingRecords: ["operationalId", "caseId", "familyOperationalId", "passengerOperationalId", "enquiryOperationalId", "status", "matchBasis", "holdCheck", "decisionNotes", "createdAt", "updatedAt"],
  Requests: ["operationalId", "caseId", "category", "priority", "requester", "ownerAssignedTo", "details", "approvalStatus", "status", "enquiryOperationalId", "familyOperationalId", "passengerOperationalId", "createdAt", "updatedAt"],
  AuditLog: ["action", "actorEmail", "actorDisplayName", "summary", "createdAt"]
} as const;

export const exportColumnSchemas = Object.fromEntries(
  Object.entries(columns).map(([section, keys]) => [section, keys.map((key) => ({ key }))])
) as Record<keyof typeof columns, CsvColumn[]>;

function fullName(firstName: string | null | undefined, lastName: string | null | undefined) {
  return [firstName, lastName].filter(Boolean).join(" ");
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function fingerprint(input: ExportPreparationInput) {
  return createHash("sha256")
    .update(input.incidentId).update("\0")
    .update(input.exportType).update("\0")
    .update(exportFormat).update("\0")
    .update(exportSchemaVersion)
    .digest("hex");
}

function safeFileComponent(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 80) || "incident";
}

function asGeneration(row: {
  id: string;
  operationId: string;
  incidentId: string;
  exportType: string;
  format: string;
  schemaVersion: string;
  fileName: string;
  contentSha256: string;
  contentSizeBytes: bigint;
  rowCount: number;
  sectionCounts: Prisma.JsonValue;
  includedSections: Prisma.JsonValue;
  preparedById: string | null;
  preparedAt: Date;
  requestId: string | null;
  status: string;
  createdAt: Date;
}) {
  return { ...row, contentSizeBytes: Number(row.contentSizeBytes) };
}

function uniqueTarget(error: Prisma.PrismaClientKnownRequestError) {
  const target = error.meta?.target;
  return Array.isArray(target) ? target.map(String).join(",") : String(target ?? "");
}

function operationConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2002"
    && uniqueTarget(error).includes("operationId");
}

function assertUuid(value: string, message: string) {
  if (!uuidPattern.test(value)) throw new HttpError(404, message);
}

function assertPermissions(actual: Permission[], required: Permission[]) {
  if (!required.every((permission) => actual.includes(permission))) throw new HttpError(403, "Forbidden");
}

function metadataTypes(permissions: Permission[]) {
  return supportedExportTypes.filter((type) => generationPermissions(type).every((permission) => permissions.includes(permission)));
}

export function createPrismaExportService(client: PrismaClient, hooks: ExportFailureHooks = {}) {
  async function pageRows<T>(section: string, remaining: number, load: (skip: number, take: number) => Promise<T[]>) {
    const result: T[] = [];
    let offset = 0;
    while (true) {
      await hooks.duringSourcePaging?.(section, offset);
      const take = Math.min(exportPageSize, remaining - result.length + 1);
      const page = await load(offset, take);
      result.push(...page);
      if (result.length > remaining) throw new HttpError(413, `Export exceeds the ${exportRowLimit.toLocaleString("en-US")} row synchronous limit`);
      if (page.length < take) break;
      offset += page.length;
    }
    return result;
  }

  async function sourceSection(db: Db, type: Exclude<FoundationExportType, "session-package">, incidentId: string, permissions: Permission[], remaining: number): Promise<CsvSection> {
    const section = exportDefinitions[type].section as keyof typeof columns;
    if (type === "enquiry-log") {
      const rows = await pageRows(section, remaining, (skip, take) => db.enquiry.findMany({
        where: { sessionId: incidentId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip, take,
        select: { operationalId: true, caseId: true, contactChannel: true, callerName: true, callerPhone: true, callerEmail: true, callerLocation: true, preferredLanguage: true, claimedRelationship: true, passengerFirstName: true, passengerLastName: true, enquiryType: true, urgency: true, status: true, notes: true, createdAt: true, updatedAt: true }
      }));
      return { name: section, columns: exportColumnSchemas[section], rows: rows.map((row) => ({ ...row, passengerName: fullName(row.passengerFirstName, row.passengerLastName) })) };
    }
    if (type === "family-register") {
      const rows = await pageRows(section, remaining, (skip, take) => db.familyRecord.findMany({
        where: { sessionId: incidentId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip, take,
        select: { operationalId: true, caseId: true, firstName: true, lastName: true, claimedRelationship: true, phone: true, email: true, preferredContactChannel: true, preferredLanguage: true, verificationStatus: true, verifiedRelationship: true, verificationDecisionBy: { select: { displayName: true } }, verificationDecisionAt: true, verificationNotes: true, immediateNeeds: true, createdAt: true, updatedAt: true }
      }));
      return { name: section, columns: exportColumnSchemas[section], rows: rows.map((row) => ({ ...row, familyName: fullName(row.firstName, row.lastName), verificationDecisionBy: row.verificationDecisionBy?.displayName ?? null })) };
    }
    if (type === "passenger-register") {
      const rows = await pageRows(section, remaining, (skip, take) => db.passengerRecord.findMany({
        where: { sessionId: incidentId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip, take,
        select: { operationalId: true, caseId: true, personType: true, firstName: true, lastName: true, dateOfBirth: true, age: true, gender: true, nationality: true, flightNumber: true, route: true, seat: true, pnr: true, ticketNumber: true, manifestVersion: true, source: true, conditionStatus: true, holdStatus: true, travellingCompanions: true, notes: true, createdAt: true, updatedAt: true }
      }));
      return { name: section, columns: exportColumnSchemas[section], rows: rows.map((row) => ({ ...row, passengerName: fullName(row.firstName, row.lastName) })) };
    }
    if (type === "matching-log") {
      const rows = await pageRows(section, remaining, (skip, take) => db.matchingRecord.findMany({
        where: { sessionId: incidentId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip, take,
        select: { operationalId: true, caseId: true, status: true, matchBasis: true, holdCheck: true, decisionNotes: true, createdAt: true, updatedAt: true, familyRecord: { select: { operationalId: true } }, passengerRecord: { select: { operationalId: true } }, enquiry: { select: { operationalId: true } } }
      }));
      return { name: section, columns: exportColumnSchemas[section], rows: rows.map((row) => ({ ...row, familyOperationalId: permissions.includes("family:read") ? row.familyRecord?.operationalId ?? null : null, passengerOperationalId: permissions.includes("passenger:read") ? row.passengerRecord?.operationalId ?? null : null, enquiryOperationalId: permissions.includes("enquiry:read") ? row.enquiry?.operationalId ?? null : null })) };
    }
    if (type === "requests-log") {
      const rows = await pageRows(section, remaining, (skip, take) => db.request.findMany({
        where: { incidentId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip, take,
        select: { operationalId: true, caseId: true, category: true, priority: true, requester: true, legacyOwnerLabel: true, details: true, approvalStatus: true, status: true, createdAt: true, updatedAt: true, owner: { select: { displayName: true } }, relatedEnquiry: { select: { operationalId: true } }, relatedFamilyRecord: { select: { operationalId: true } }, relatedPassengerRecord: { select: { operationalId: true } } }
      }));
      return { name: section, columns: exportColumnSchemas[section], rows: rows.map((row) => ({ ...row, ownerAssignedTo: row.owner?.displayName ?? row.legacyOwnerLabel, enquiryOperationalId: permissions.includes("enquiry:read") ? row.relatedEnquiry?.operationalId ?? null : null, familyOperationalId: permissions.includes("family:read") ? row.relatedFamilyRecord?.operationalId ?? null : null, passengerOperationalId: permissions.includes("passenger:read") ? row.relatedPassengerRecord?.operationalId ?? null : null })) };
    }
    const rows = await pageRows(section, remaining, (skip, take) => db.auditLog.findMany({
      where: { sessionId: incidentId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip, take,
      select: { action: true, actorEmail: true, summary: true, createdAt: true, actor: { select: { displayName: true } } }
    }));
    return { name: section, columns: exportColumnSchemas[section], rows: rows.map((row) => ({ ...row, actorDisplayName: row.actor?.displayName ?? null })) };
  }

  async function incidentSession(db: Db, incidentId: string) {
    const session = await db.session.findUnique({ where: { id: incidentId }, select: { id: true, operationalId: true, mode: true, status: true, eventType: true, flightNumber: true, route: true, startAt: true, endAt: true } });
    if (!session) throw new HttpError(404, "Incident not found");
    return session;
  }

  return {
    kind: "postgres" as const,

    async authorizationContext(generationId: string): Promise<ExportAuthorizationContext> {
      assertUuid(generationId, "Export generation not found");
      const generation = await client.exportGeneration.findUnique({ where: { id: generationId }, select: { id: true, incidentId: true, exportType: true } });
      if (!generation || !isFoundationExportType(generation.exportType)) throw new HttpError(404, "Export generation not found");
      return { ...generation, exportType: generation.exportType };
    },

    async prepare(input: ExportPreparationInput, actor: ExportActor) {
      if (await client.exportGeneration.findUnique({ where: { operationId: input.operationId }, select: { id: true } })) {
        throw new HttpError(409, "That export generation was already prepared. Start a new export if another copy is required.");
      }
      try {
        return await client.$transaction(async (tx) => {
          const permissions = await new EffectiveAccessService(tx).effectivePermissionsForUser(actor.id, { incidentId: input.incidentId });
          assertPermissions(permissions, ["export:create", "session:read", ...(isDatasetExportType(input.exportType) ? [exportDefinitions[input.exportType].permission] : [])] as Permission[]);
          await hooks.beforeSourceQuery?.();
          const session = await incidentSession(tx, input.incidentId);
          const sections: CsvSection[] = [{
            name: "Session",
            columns: exportColumnSchemas.Session,
            rows: [{ operationalId: session.operationalId, mode: session.mode, status: session.status, eventType: session.eventType, flightNumber: session.flightNumber, route: session.route, startedAt: session.startAt, endedAt: session.endAt }]
          }];
          let rowCount = 0;
          const requested = isDatasetExportType(input.exportType)
            ? [input.exportType]
            : (Object.keys(exportDefinitions) as Array<keyof typeof exportDefinitions>).filter((type) => permissions.includes(exportDefinitions[type].permission));
          for (const type of requested) {
            const section = await sourceSection(tx, type, input.incidentId, permissions, exportRowLimit - rowCount);
            sections.push(section);
            rowCount += section.rows.length;
          }
          await hooks.beforeSerialization?.();
          const buffer = serializeCsvSections(sections);
          if (buffer.byteLength > exportByteLimit) throw new HttpError(413, "Export exceeds the 20 MB synchronous response limit");
          const generationId = randomUUID();
          const preparedAt = new Date();
          const fileName = `zpp-${safeFileComponent(session.operationalId)}-${input.exportType}.csv`;
          const contentSha256 = createHash("sha256").update(buffer).digest("hex");
          const includedSections = sections.map((section) => section.name);
          const sectionCounts = Object.fromEntries(sections.map((section) => [section.name, section.rows.length]));
          await hooks.beforeGenerationWrite?.();
          const generation = await tx.exportGeneration.create({ data: {
            id: generationId,
            operationId: input.operationId,
            commandFingerprint: fingerprint(input),
            incidentId: input.incidentId,
            exportType: input.exportType,
            format: exportFormat,
            schemaVersion: exportSchemaVersion,
            fileName,
            contentSha256,
            contentSizeBytes: BigInt(buffer.byteLength),
            rowCount,
            sectionCounts: json(sectionCounts),
            includedSections: json(includedSections),
            preparedById: actor.id,
            preparedAt,
            requestId: actor.requestId,
            status: "Prepared"
          } });
          await hooks.beforeAudit?.();
          await tx.auditLog.create({ data: {
            action: "export_prepared",
            entityType: "exportGeneration",
            entityId: generationId,
            sessionId: input.incidentId,
            actorId: actor.id,
            actorEmail: actor.email,
            summary: `Prepared ${input.exportType} CSV export`,
            metadata: json({ generationId, exportType: input.exportType, format: exportFormat, schemaVersion: exportSchemaVersion, includedSections, rowCount, sectionCounts, contentSha256, contentSizeBytes: buffer.byteLength, operationId: input.operationId, requestId: actor.requestId ?? null })
          } });
          await hooks.afterAuditBeforeReturn?.();
          return { buffer, generation: asGeneration(generation) };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      } catch (error) {
        if (operationConflict(error) || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && await client.exportGeneration.findUnique({ where: { operationId: input.operationId }, select: { id: true } }))) {
          throw new HttpError(409, "That export generation was already prepared. Start a new export if another copy is required.");
        }
        throw error;
      }
    },

    async get(generationId: string) {
      assertUuid(generationId, "Export generation not found");
      const generation = await client.exportGeneration.findUnique({ where: { id: generationId } });
      if (!generation) throw new HttpError(404, "Export generation not found");
      return asGeneration(generation);
    },

    async list(incidentId: string, permissions: Permission[], page: { limit: number; offset: number }) {
      const exportTypes = metadataTypes(permissions);
      const where = { incidentId, exportType: { in: exportTypes } };
      const [total, rows] = await Promise.all([
        client.exportGeneration.count({ where }),
        client.exportGeneration.findMany({ where, orderBy: [{ preparedAt: "desc" }, { id: "desc" }], take: page.limit, skip: page.offset })
      ]);
      return { total, data: rows.map(asGeneration) };
    },

    async sessionSummary(incidentId: string, actorId: string) {
      return client.$transaction(async (tx) => {
        const permissions = await new EffectiveAccessService(tx).effectivePermissionsForUser(actorId, { incidentId });
        assertPermissions(permissions, ["reports:read", "session:read"]);
        const session = await incidentSession(tx, incidentId);
        const availability = {
          enquiries: permissions.includes("enquiry:read"),
          families: permissions.includes("family:read"),
          passengers: permissions.includes("passenger:read"),
          matches: permissions.includes("matching:read"),
          requests: permissions.includes("request:read"),
          releases: permissions.includes("release:read"),
          imports: permissions.includes("import:create")
        };
        const counts: Record<string, number> = {};
        if (availability.enquiries) counts.enquiries = await tx.enquiry.count({ where: { sessionId: incidentId } });
        if (availability.families) counts.families = await tx.familyRecord.count({ where: { sessionId: incidentId } });
        if (availability.passengers) counts.passengers = await tx.passengerRecord.count({ where: { sessionId: incidentId } });
        if (availability.matches) counts.matches = await tx.matchingRecord.count({ where: { sessionId: incidentId } });
        if (availability.requests) counts.requests = await tx.request.count({ where: { incidentId } });
        if (availability.releases) counts.releases = await tx.releaseAction.count({ where: { incidentId } });
        if (availability.imports) counts.imports = await tx.importBatch.count({ where: { sessionId: incidentId } });
        const holds = availability.matches ? await tx.matchingRecord.findMany({ where: { sessionId: incidentId, holdCheck: { not: "No hold" } }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 20, select: { operationalId: true, status: true, holdCheck: true, updatedAt: true } }) : undefined;
        const urgentRequests = availability.requests ? await tx.request.findMany({ where: { incidentId, priority: "Urgent", status: { notIn: terminalRequestStatuses } }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 20, select: { operationalId: true, category: true, priority: true, status: true, dueAt: true, updatedAt: true } }) : undefined;
        return { session, availability, counts, ...(holds ? { holds } : {}), ...(urgentRequests ? { urgentRequests } : {}) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    }
  };
}

export type PrismaExportService = ReturnType<typeof createPrismaExportService>;

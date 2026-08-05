import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import type { FamilyRepository } from "./family-repository.js";
import { normalizeEmail, normalizePhone } from "./family-service.js";
import type { FamilyActor, FamilyClaimCorrection, FamilyClaimFacts, FamilyCreateInput, FamilyRecord } from "./family-types.js";

const familyInclude = {
  verificationDecisionBy: { select: { displayName: true } },
  _count: { select: { relationshipClaims: true } },
  relationshipClaims: {
    where: { isCurrent: true },
    take: 1,
    include: {
      decisions: {
        orderBy: { decisionAt: "desc" as const },
        include: { decisionBy: { select: { displayName: true } } }
      }
    }
  }
} satisfies Prisma.FamilyRecordInclude;

type IncludedFamily = Prisma.FamilyRecordGetPayload<{ include: typeof familyInclude }>;

function metadata(value: Record<string, unknown>): Prisma.InputJsonValue {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Prisma.InputJsonObject;
}

function mapDecision({ decisionBy, ...decision }: IncludedFamily["relationshipClaims"][number]["decisions"][number]) {
  return {
    ...decision,
    result: decision.result as "VERIFIED" | "REJECTED" | "REOPENED",
    decisionByDisplayName: decisionBy?.displayName ?? null
  };
}

function asRecord(row: IncludedFamily, duplicateIds: string[] = [], decisionHistory?: FamilyRecord["decisionHistory"]): FamilyRecord {
  const { relationshipClaims, verificationDecisionBy, _count, ...record } = row;
  const claim = relationshipClaims[0];
  if (!claim) throw new Error(`Family/NOK ${row.id} has no current relationship claim`);
  return {
    ...record,
    verificationDecisionByDisplayName: verificationDecisionBy?.displayName ?? null,
    currentClaim: {
      ...claim,
      status: claim.status as FamilyRecord["currentClaim"]["status"],
      decisions: claim.decisions.map(mapDecision)
    },
    decisionHistory: decisionHistory ?? claim.decisions.map(mapDecision),
    claimHistoryCount: _count.relationshipClaims,
    potentialDuplicateIds: duplicateIds
  };
}

async function fullDecisionHistory(db: PrismaClient | Prisma.TransactionClient, incidentId: string, familyId: string) {
  const rows = await db.relationshipVerificationDecision.findMany({
    where: { incidentId, relationshipClaim: { familyRecordId: familyId } },
    orderBy: { decisionAt: "desc" },
    include: { decisionBy: { select: { displayName: true } } }
  });
  return rows.map(({ decisionBy, ...decision }) => ({ ...decision, result: decision.result as "VERIFIED" | "REJECTED" | "REOPENED", decisionByDisplayName: decisionBy?.displayName ?? null }));
}

async function operationalIds(tx: Prisma.TransactionClient, count = 1) {
  const rows = await tx.$queryRaw<Array<{ value: bigint }>>`
    SELECT nextval('"FamilyRecord_operational_seq"') AS value
    FROM generate_series(1, ${count})
  `;
  const year = new Date().getFullYear();
  return rows.map((row) => `FAM-${year}-${String(row.value).padStart(6, "0")}`);
}

async function assertWritable(tx: Prisma.TransactionClient, incidentId: string) {
  const writable = await tx.session.count({ where: { id: incidentId, status: { notIn: ["Closed", "Archived"] } } });
  if (writable !== 1) throw new HttpError(409, "Family/NOK records in a closed incident are read-only");
}

async function assertPassenger(tx: Prisma.TransactionClient, incidentId: string, passengerRecordId?: string | null) {
  if (!passengerRecordId) return;
  const count = await tx.passengerRecord.count({ where: { id: passengerRecordId, sessionId: incidentId } });
  if (count !== 1) throw new HttpError(409, "Linked Passenger must belong to the same incident");
}

function familyData(input: Partial<FamilyClaimFacts>) {
  return {
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone,
    email: input.email,
    normalizedPhone: input.phone === undefined ? undefined : normalizePhone(input.phone),
    normalizedEmail: input.email === undefined ? undefined : normalizeEmail(input.email),
    preferredContactChannel: input.preferredContactChannel,
    preferredLanguage: input.preferredLanguage,
    location: input.location,
    claimedRelationship: input.claimedRelationship,
    passengerFirstName: input.passengerFirstName,
    passengerLastName: input.passengerLastName,
    passengerFlight: input.passengerFlight
  };
}

function claimData(input: Partial<FamilyClaimFacts>) {
  return {
    passengerRecordId: input.passengerRecordId,
    claimedRelationshipType: input.claimedRelationship,
    claimedPassengerFirstName: input.passengerFirstName,
    claimedPassengerLastName: input.passengerLastName,
    claimedPassengerFlight: input.passengerFlight
  };
}

async function read(tx: Prisma.TransactionClient, incidentId: string, familyId: string) {
  return tx.familyRecord.findFirst({ where: { id: familyId, sessionId: incidentId }, include: familyInclude });
}

async function potentialDuplicates(tx: Prisma.TransactionClient, incidentId: string, familyId: string, normalizedPhone?: string | null, normalizedEmail?: string | null) {
  if (!normalizedPhone && !normalizedEmail) return [];
  const rows = await tx.familyRecord.findMany({
    where: {
      sessionId: incidentId,
      id: { not: familyId },
      OR: [
        normalizedPhone ? { normalizedPhone } : undefined,
        normalizedEmail ? { normalizedEmail } : undefined
      ].filter(Boolean) as Prisma.FamilyRecordWhereInput[]
    },
    select: { id: true },
    take: 20
  });
  return rows.map((item) => item.id);
}

async function audit(tx: Prisma.TransactionClient, context: { incidentId: string; actorId: string }, actor: FamilyActor, record: { id: string; operationalId: string }, action: string, summary: string, data: Record<string, unknown>) {
  await tx.auditLog.create({
    data: {
      action,
      entityType: "familyRecord",
      entityId: record.id,
      sessionId: context.incidentId,
      actorId: context.actorId,
      actorEmail: actor.email,
      summary,
      metadata: metadata({ ...data, requestId: actor.requestId })
    }
  });
}

async function timeline(tx: Prisma.TransactionClient, context: { incidentId: string; actorId: string }, record: { id: string; operationalId: string; caseId: string | null }, title: string, body?: string | null, data: Record<string, unknown> = {}) {
  await tx.caseTimelineEvent.create({
    data: {
      sessionId: context.incidentId,
      caseId: record.caseId,
      eventType: "family_relationship",
      entityType: "familyRecord",
      entityId: record.id,
      title,
      body: body ?? null,
      metadata: metadata(data),
      createdById: context.actorId
    }
  });
}

function createFamilyRow(input: FamilyCreateInput, operationalId: string, actorId: string, sourceBatchId?: string) {
  return {
    ...familyData(input),
    operationalId,
    sessionId: input.sessionId,
    caseId: input.caseId,
    sourceBatchId,
    sourceImportedAt: sourceBatchId ? new Date() : null,
    immediateNeeds: input.immediateNeeds,
    questionsAsked: input.questionsAsked,
    commitmentsMade: input.commitmentsMade,
    nextContactDue: input.nextContactDue,
    assignedOfficer: input.assignedOfficer,
    notes: input.notes,
    verificationStatus: "Unverified",
    createdById: actorId,
    updatedById: actorId
  } as Prisma.FamilyRecordUncheckedCreateInput;
}

export function createPrismaFamilyRepository(client: PrismaClient): FamilyRepository {
  return {
    kind: "postgres",

    async list(context, query) {
      const claimFilter: Prisma.RelationshipClaimListRelationFilter = {
        some: {
          isCurrent: true,
          claimedRelationshipType: query.relationship,
          passengerRecordId: query.passengerLinked === undefined ? undefined : query.passengerLinked ? { not: null } : null
        }
      };
      const where: Prisma.FamilyRecordWhereInput = {
        sessionId: context.incidentId,
        verificationStatus: query.verificationStatus,
        relationshipClaims: query.relationship || query.passengerLinked !== undefined ? claimFilter : undefined,
        OR: query.search ? ["operationalId", "firstName", "lastName", "phone", "email", "passengerFirstName", "passengerLastName", "passengerFlight", "caseId"].map((field) => ({ [field]: { contains: query.search, mode: "insensitive" } })) : undefined
      };
      const orderBy = [{ [query.sortBy]: query.sortDirection }, { id: query.sortDirection }] as Prisma.FamilyRecordOrderByWithRelationInput[];
      const [total, rows] = await Promise.all([
        client.familyRecord.count({ where }),
        client.familyRecord.findMany({ where, take: query.limit, skip: query.offset, orderBy, include: familyInclude })
      ]);
      return { total, data: rows.map((row) => asRecord(row)) };
    },

    async getById(context, familyId) {
      const row = await client.familyRecord.findFirst({ where: { id: familyId, sessionId: context.incidentId }, include: familyInclude });
      if (!row) return null;
      const duplicates = await potentialDuplicates(client as unknown as Prisma.TransactionClient, context.incidentId, row.id, row.normalizedPhone, row.normalizedEmail);
      return asRecord(row, duplicates, await fullDecisionHistory(client, context.incidentId, familyId));
    },

    async create(context, input, actor) {
      return client.$transaction(async (tx) => {
        await assertWritable(tx, context.incidentId);
        await assertPassenger(tx, context.incidentId, input.passengerRecordId);
        const [operationalId] = await operationalIds(tx);
        const record = await tx.familyRecord.create({ data: createFamilyRow({ ...input, sessionId: context.incidentId }, operationalId!, context.actorId) });
        const claim = await tx.relationshipClaim.create({
          data: { incidentId: context.incidentId, familyRecordId: record.id, ...claimData(input), source: input.source ?? "OPERATOR", claimedById: context.actorId }
        });
        const duplicateIds = await potentialDuplicates(tx, context.incidentId, record.id, record.normalizedPhone, record.normalizedEmail);
        await audit(tx, context, actor, record, "create_family_record", `Family/NOK record ${record.operationalId} registered`, { relationshipClaimId: claim.id, passengerRecordId: claim.passengerRecordId, claimedRelationship: claim.claimedRelationshipType, potentialDuplicateIds: duplicateIds, version: 1 });
        await timeline(tx, context, record, `Family/NOK record ${record.operationalId} registered`, undefined, { relationshipClaimId: claim.id, passengerRecordId: claim.passengerRecordId, verificationStatus: "Unverified" });
        return asRecord((await read(tx, context.incidentId, record.id))!, duplicateIds, []);
      });
    },

    async update(context, familyId, input, expectedVersion, actor) {
      return client.$transaction(async (tx) => {
        const before = await read(tx, context.incidentId, familyId);
        if (!before) return { record: null, conflict: false };
        const changed = await tx.familyRecord.updateMany({
          where: { id: familyId, sessionId: context.incidentId, version: expectedVersion, session: { status: { notIn: ["Closed", "Archived"] } } },
          data: { ...input, updatedById: context.actorId, version: { increment: 1 } }
        });
        if (changed.count !== 1) return { record: null, conflict: true };
        const record = (await read(tx, context.incidentId, familyId))!;
        await audit(tx, context, actor, record, "update_family_record", `Family/NOK record ${record.operationalId} updated`, { changedFields: Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined), versionBefore: expectedVersion, versionAfter: record.version });
        return { record: asRecord(record, [], await fullDecisionHistory(tx, context.incidentId, familyId)), conflict: false };
      });
    },

    async correctClaim(context, familyId, input, expectedVersion, expectedClaimVersion, actor) {
      return client.$transaction(async (tx) => {
        const before = await read(tx, context.incidentId, familyId);
        if (!before) return { record: null, conflict: false };
        const current = before.relationshipClaims[0];
        if (!current || current.version !== expectedClaimVersion) return { record: null, conflict: true };
        const { reason, ...facts } = input;
        const nextPassengerId = facts.passengerRecordId === undefined ? current.passengerRecordId : facts.passengerRecordId;
        await assertPassenger(tx, context.incidentId, nextPassengerId);
        const familyChanged = await tx.familyRecord.updateMany({
          where: { id: familyId, sessionId: context.incidentId, version: expectedVersion, session: { status: { notIn: ["Closed", "Archived"] } } },
          data: { ...familyData(facts), updatedById: context.actorId, version: { increment: 1 }, ...(current.status === "PENDING" ? {} : { verificationStatus: "Review required", verificationNotes: reason, verificationDecisionById: null, verificationDecisionAt: null, verifiedRelationship: null }) }
        });
        if (familyChanged.count !== 1) return { record: null, conflict: true };
        let nextClaimId = current.id;
        if (current.status === "PENDING") {
          const changed = await tx.relationshipClaim.updateMany({ where: { id: current.id, incidentId: context.incidentId, isCurrent: true, version: expectedClaimVersion }, data: { ...claimData(facts), version: { increment: 1 } } });
          if (changed.count !== 1) return { record: null, conflict: true };
        } else {
          const superseded = await tx.relationshipClaim.updateMany({ where: { id: current.id, incidentId: context.incidentId, isCurrent: true, version: expectedClaimVersion }, data: { isCurrent: false, status: "SUPERSEDED", supersededAt: new Date(), version: { increment: 1 } } });
          if (superseded.count !== 1) return { record: null, conflict: true };
          const next = await tx.relationshipClaim.create({ data: { incidentId: context.incidentId, familyRecordId: familyId, passengerRecordId: nextPassengerId, claimedRelationshipType: facts.claimedRelationship === undefined ? current.claimedRelationshipType : facts.claimedRelationship, claimedPassengerFirstName: facts.passengerFirstName === undefined ? current.claimedPassengerFirstName : facts.passengerFirstName, claimedPassengerLastName: facts.passengerLastName === undefined ? current.claimedPassengerLastName : facts.passengerLastName, claimedPassengerFlight: facts.passengerFlight === undefined ? current.claimedPassengerFlight : facts.passengerFlight, source: "CORRECTION", claimedById: context.actorId } });
          nextClaimId = next.id;
        }
        const record = (await read(tx, context.incidentId, familyId))!;
        const changedFields = Object.keys(facts).filter((key) => facts[key as keyof typeof facts] !== undefined);
        await audit(tx, context, actor, record, "correct_family_claim", `Claimed facts corrected for ${record.operationalId}`, { changedFields, reason, previousClaimId: current.id, currentClaimId: nextClaimId, verificationReviewRequired: current.status !== "PENDING", passengerRecordId: nextPassengerId, versionBefore: expectedVersion, versionAfter: record.version });
        await timeline(tx, context, record, `Relationship claim corrected for ${record.operationalId}`, reason, { changedFields, previousClaimId: current.id, currentClaimId: nextClaimId, verificationReviewRequired: current.status !== "PENDING" });
        return { record: asRecord(record, [], await fullDecisionHistory(tx, context.incidentId, familyId)), conflict: false };
      });
    },

    async decide(context, familyId, input, expectedVersion, expectedClaimVersion, actor) {
      return client.$transaction(async (tx) => {
        const before = await read(tx, context.incidentId, familyId);
        if (!before) return { record: null, conflict: false };
        const claim = before.relationshipClaims[0];
        if (!claim || claim.version !== expectedClaimVersion) return { record: null, conflict: true };
        const nextStatus = input.result === "VERIFIED" ? "VERIFIED" : input.result === "REJECTED" ? "REJECTED" : "PENDING";
        const projection = input.result === "VERIFIED" ? "Verified" : input.result === "REJECTED" ? "Rejected" : "Review required";
        const decidedAt = new Date();
        const changedClaim = await tx.relationshipClaim.updateMany({ where: { id: claim.id, incidentId: context.incidentId, isCurrent: true, version: expectedClaimVersion, status: claim.status }, data: { status: nextStatus, version: { increment: 1 } } });
        if (changedClaim.count !== 1) return { record: null, conflict: true };
        const changedFamily = await tx.familyRecord.updateMany({
          where: { id: familyId, sessionId: context.incidentId, version: expectedVersion, session: { status: { notIn: ["Closed", "Archived"] } } },
          data: { verificationStatus: projection, verificationNotes: input.basis, verificationDecisionById: input.result === "REOPENED" ? null : context.actorId, verificationDecisionAt: input.result === "REOPENED" ? null : decidedAt, verifiedRelationship: input.result === "VERIFIED" ? (input.verifiedRelationshipType ?? claim.claimedRelationshipType) : null, updatedById: context.actorId, version: { increment: 1 } }
        });
        if (changedFamily.count !== 1) return { record: null, conflict: true };
        const decision = await tx.relationshipVerificationDecision.create({ data: { incidentId: context.incidentId, relationshipClaimId: claim.id, result: input.result, basis: input.basis, verifiedRelationshipType: input.result === "VERIFIED" ? (input.verifiedRelationshipType ?? claim.claimedRelationshipType) : null, previousStatus: claim.status, nextStatus, claimVersionBefore: expectedClaimVersion, claimVersionAfter: expectedClaimVersion + 1, decisionById: context.actorId, decisionAt: decidedAt, requestId: actor.requestId } });
        const record = (await read(tx, context.incidentId, familyId))!;
        const action = input.result === "VERIFIED" ? "verify_family_relationship" : input.result === "REJECTED" ? "reject_family_relationship" : "reopen_family_relationship";
        await audit(tx, context, actor, record, action, `Relationship claim for ${record.operationalId} ${input.result.toLocaleLowerCase()}`, { relationshipClaimId: claim.id, decisionId: decision.id, passengerRecordId: claim.passengerRecordId, claimedRelationship: claim.claimedRelationshipType, verifiedRelationship: decision.verifiedRelationshipType, result: input.result, basis: input.basis, before: claim.status, after: nextStatus, familyVersionBefore: expectedVersion, familyVersionAfter: record.version, claimVersionBefore: expectedClaimVersion, claimVersionAfter: expectedClaimVersion + 1 });
        await timeline(tx, context, record, `Relationship ${input.result === "VERIFIED" ? "verified" : input.result === "REJECTED" ? "rejected" : "reopened"}`, input.basis, { relationshipClaimId: claim.id, passengerRecordId: claim.passengerRecordId, relationship: decision.verifiedRelationshipType ?? claim.claimedRelationshipType, result: input.result, version: record.version });
        return { record: asRecord(record, [], await fullDecisionHistory(tx, context.incidentId, familyId)), conflict: false };
      });
    },

    async importRecords(context, input, actor) {
      return client.$transaction(async (tx) => {
        await assertWritable(tx, context.incidentId);
        const existing = await tx.importBatch.findFirst({ where: { id: input.batchId, sessionId: context.incidentId } });
        if (existing) throw new HttpError(409, "Import batch has already been confirmed");
        const ids = await operationalIds(tx, input.records.length);
        const status = input.invalidRecords > 0 ? "Imported with errors" : "Imported";
        await tx.importBatch.create({ data: { id: input.batchId, operationalId: `IMP-${new Date().getFullYear()}-${input.batchId.replaceAll("-", "").slice(0, 12).toUpperCase()}`, sessionId: context.incidentId, importType: "family", sourceFilename: input.sourceFilename, status, totalRecords: input.totalRecords, validRecords: input.records.length, invalidRecords: input.invalidRecords, errors: input.errors as Prisma.InputJsonValue, createdById: context.actorId } });
        const linkedPassengerIds = Array.from(new Set(input.records.map((item) => item.passengerRecordId).filter((id): id is string => Boolean(id))));
        if (linkedPassengerIds.length) {
          const validPassengerCount = await tx.passengerRecord.count({ where: { id: { in: linkedPassengerIds }, sessionId: context.incidentId } });
          if (validPassengerCount !== linkedPassengerIds.length) throw new HttpError(409, "Every linked Passenger must belong to the import incident");
        }
        if (input.records.length) {
          const familyIds = input.records.map(() => randomUUID());
          await tx.familyRecord.createMany({
            data: input.records.map((item, index) => ({ id: familyIds[index]!, ...createFamilyRow({ ...item, sessionId: context.incidentId, source: "IMPORT" }, ids[index]!, context.actorId, input.batchId) })) as Prisma.FamilyRecordCreateManyInput[]
          });
          await tx.relationshipClaim.createMany({
            data: input.records.map((item, index) => ({ id: randomUUID(), incidentId: context.incidentId, familyRecordId: familyIds[index]!, ...claimData(item), source: "IMPORT", claimedById: context.actorId })) as Prisma.RelationshipClaimCreateManyInput[]
          });
        }
        await tx.auditLog.create({ data: { action: "import_family_records", entityType: "importBatch", entityId: input.batchId, sessionId: context.incidentId, actorId: context.actorId, actorEmail: actor.email, summary: `Imported Family/NOK records: ${input.records.length}/${input.totalRecords} valid`, metadata: metadata({ sourceFilename: input.sourceFilename, totalRecords: input.totalRecords, validRecords: input.records.length, invalidRecords: input.invalidRecords, requestId: actor.requestId }) } });
        await tx.caseTimelineEvent.create({ data: { sessionId: context.incidentId, eventType: "family_import", entityType: "importBatch", entityId: input.batchId, title: `Family/NOK records imported (${input.records.length} records)`, metadata: { totalRecords: input.totalRecords, validRecords: input.records.length }, createdById: context.actorId } });
        return { batchId: input.batchId, status, totalRecords: input.totalRecords, validRecords: input.records.length, invalidRecords: input.invalidRecords };
      });
    }
  };
}

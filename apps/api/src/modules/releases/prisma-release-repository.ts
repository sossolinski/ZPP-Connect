import { Prisma, type PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type { ReleaseRepository } from "./release-repository.js";
import type {
  PrepareReleaseInput,
  RecordHoldReviewInput,
  RecordIdentityCheckInput,
  ReleaseActionRecord,
  ReleaseActor,
  ReleaseCandidateRecord,
  ReleaseCheckRecord,
  ReleaseCompatibilityRecord,
  ReleaseDecisionInput,
  ReleaseMutationResult,
  ReleasePrecondition,
  ReleaseQueueQuery
} from "./release-types.js";

const actionInclude = {
  relationshipClaim: { include: { familyRecord: { select: { id: true, operationalId: true, firstName: true, lastName: true, caseId: true } } } },
  matchDecision: true,
  matchingRecord: { select: { id: true, holdCheck: true } },
  passengerRecord: { select: { id: true, operationalId: true, firstName: true, lastName: true, holdStatus: true, conditionStatus: true, version: true } },
  preparedBy: { select: { displayName: true } },
  authorizedBy: { select: { displayName: true } },
  completedBy: { select: { displayName: true } },
  checks: { orderBy: { checkedAt: "desc" as const }, include: { actor: { select: { displayName: true } } } }
} satisfies Prisma.ReleaseActionInclude;

function json(value: Record<string, unknown>): Prisma.InputJsonValue {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Prisma.InputJsonObject;
}

function noHold(value?: string | null) {
  return !value || value === "No hold";
}

function fingerprint(command: string, actionId: string, values: unknown[]) {
  return JSON.stringify([command, actionId, ...values]);
}

function checkRecord(row: any, action: any): ReleaseCheckRecord {
  const claim = action.relationshipClaim;
  const passenger = action.passengerRecord;
  const current = Boolean(
    row.isCurrent &&
      row.relationshipClaimId === action.relationshipClaimId &&
      row.matchDecisionId === action.matchDecisionId &&
      row.claimVersion === claim?.version &&
      row.passengerVersion === passenger?.version
  );
  return { ...row, type: row.type, result: row.result, actorDisplayName: row.actor?.displayName ?? null, current };
}

function precondition(key: ReleasePrecondition["key"], label: string, state: ReleasePrecondition["state"], detail: string): ReleasePrecondition {
  return { key, label, state, detail };
}

function actionRecord(row: any): ReleaseActionRecord {
  const claim = row.relationshipClaim;
  const decision = row.matchDecision;
  const passenger = row.passengerRecord;
  const checks = row.checks.map((item: any) => checkRecord(item, row));
  const identity = checks.find((item: ReleaseCheckRecord) => item.type === "IDENTITY" && item.isCurrent);
  const holdReview = checks.find((item: ReleaseCheckRecord) => item.type === "HOLD_REVIEW" && item.isCurrent);
  const relationshipCurrent = Boolean(claim && claim.isCurrent && claim.status === "VERIFIED" && claim.version === row.relationshipClaimVersion);
  const matchCurrent = Boolean(
    decision &&
      decision.decision === "CONFIRMED" &&
      decision.validity === "CURRENT" &&
      decision.isCurrent &&
      decision.relationshipClaimId === row.relationshipClaimId &&
      decision.passengerRecordId === row.passengerRecordId &&
      decision.claimVersion === claim?.version &&
      decision.passengerVersion === passenger?.version
  );
  const inputsCurrent = Boolean(relationshipCurrent && matchCurrent && passenger && passenger.version === row.passengerVersion);
  const identityCurrent = Boolean(identity?.current && identity.result === "PASS");
  const passengerHoldClear = Boolean(passenger && noHold(passenger.holdStatus));
  const matchingHoldClear = Boolean(row.matchingRecord && noHold(row.matchingRecord.holdCheck));
  const holdReviewCurrent = Boolean(holdReview?.current && holdReview.result === "PASS" && passengerHoldClear);
  const authorizationCurrent = row.status !== "AUTHORIZED" || (
    row.authorizedClaimVersion === claim?.version && row.authorizedPassengerVersion === passenger?.version
  );
  const preconditions: ReleasePrecondition[] = [
    precondition("relationship", "Relationship verified", relationshipCurrent ? "PASS" : claim && !claim.isCurrent ? "STALE" : "FAIL", relationshipCurrent ? "Current RelationshipClaim is VERIFIED" : "RelationshipClaim is not current and verified at the prepared version"),
    precondition("match", "Current human match", matchCurrent ? "PASS" : decision ? "STALE" : "FAIL", matchCurrent ? "Current human MatchDecision is CONFIRMED" : "MatchDecision is absent, stale, invalidated or superseded"),
    precondition("inputs", "Prepared inputs current", inputsCurrent && authorizationCurrent ? "PASS" : "STALE", inputsCurrent && authorizationCurrent ? `Claim v${claim?.version}; Passenger v${passenger?.version}` : "Data used to prepare or authorize this action changed"),
    precondition("identity", "Identity check", identityCurrent ? "PASS" : identity?.current ? "FAIL" : identity ? "STALE" : "FAIL", identityCurrent ? `PASS by ${identity?.actorDisplayName ?? "recorded operator"}` : identity ? "Identity check failed or is no longer current" : "No explicit identity check recorded"),
    precondition("passengerHold", "Passenger hold", passengerHoldClear ? "PASS" : "BLOCKED", passengerHoldClear ? "Passenger hold state allows release" : `Active Passenger hold: ${passenger?.holdStatus ?? "Unknown"}`),
    precondition("matchingHold", "Matching hold", matchingHoldClear ? "PASS" : "BLOCKED", matchingHoldClear ? "Stage 5 matching projection has no active hold" : `Active Matching hold: ${row.matchingRecord?.holdCheck ?? "Unknown"}`),
    precondition("holdReview", "Hold review", holdReviewCurrent ? "PASS" : holdReview?.current ? "FAIL" : holdReview ? "STALE" : "FAIL", holdReviewCurrent ? `Current hold reviewed by ${holdReview?.actorDisplayName ?? "recorded operator"}` : holdReview ? "Hold review failed or is no longer current" : "No explicit hold review recorded")
  ];
  const blockers = preconditions.filter((item) => item.state !== "PASS").map((item) => item.detail);
  const stale = preconditions.some((item) => item.state === "STALE");
  const effectiveState = stale ? "REQUIRES_REVIEW" : blockers.length ? "BLOCKED" : "CURRENT";
  return {
    ...row,
    actionType: row.actionType,
    status: row.status,
    effectiveState,
    preparedByDisplayName: row.preparedBy?.displayName ?? null,
    authorizedByDisplayName: row.authorizedBy?.displayName ?? null,
    completedByDisplayName: row.completedBy?.displayName ?? null,
    passenger: passenger ?? null,
    relationship: claim ? {
      id: claim.id,
      status: claim.status,
      isCurrent: claim.isCurrent,
      version: claim.version,
      relationshipType: claim.claimedRelationshipType,
      family: claim.familyRecord
    } : null,
    match: decision ? { id: decision.id, decision: decision.decision, validity: decision.validity, isCurrent: decision.isCurrent, decidedAt: decision.decidedAt } : null,
    checks,
    preconditions,
    blockers,
    canAuthorize: row.status === "PREPARED" && blockers.length === 0,
    canComplete: row.status === "AUTHORIZED" && blockers.length === 0 && authorizationCurrent
  };
}

function compatibility(record: ReleaseActionRecord): ReleaseCompatibilityRecord {
  const identity = record.checks.find((item) => item.type === "IDENTITY" && item.isCurrent && item.current && item.result === "PASS");
  const hold = record.checks.find((item) => item.type === "HOLD_REVIEW" && item.isCurrent && item.current && item.result === "PASS");
  const status = ({ PREPARED: "Prepared", AUTHORIZED: "Authorized", COMPLETED: "Completed", CANCELLED: "Cancelled" } as const)[record.status];
  return {
    id: record.id,
    operationalId: record.operationalId,
    sessionId: record.incidentId,
    matchId: record.matchingRecordId,
    passengerRecordId: record.passengerRecordId,
    familyRecordId: record.relationship?.family.id ?? null,
    actionType: record.actionType === "RELEASE" ? "Release" : "Reunification",
    status,
    identityChecked: Boolean(identity),
    holdCleared: Boolean(hold && noHold(record.passenger?.holdStatus)),
    releaseDestination: record.releaseDestination,
    receivingParty: record.receivingParty,
    transportMode: record.transportMode,
    notes: record.completionNotes ?? record.cancelReason ?? record.notes,
    version: record.version,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

async function findAction(db: PrismaClient | Prisma.TransactionClient, incidentId: string, id: string) {
  return db.releaseAction.findFirst({ where: { id, incidentId }, include: actionInclude });
}

async function operationRetry(tx: Prisma.TransactionClient, incidentId: string, operationId: string, commandFingerprint: string) {
  const operation = await tx.releaseOperation.findUnique({ where: { incidentId_operationId: { incidentId, operationId } } });
  if (!operation) return null;
  if (operation.commandFingerprint !== commandFingerprint) throw new HttpError(409, "operationId was already used for a different release command");
  return operation.releaseActionId;
}

async function assertOperationIdUnusedByCheck(tx: Prisma.TransactionClient, incidentId: string, operationId: string) {
  if (await tx.releaseCheck.count({ where: { incidentId, operationId } })) throw new HttpError(409, "operationId was already used for a different release command");
}

async function assertWritable(tx: Prisma.TransactionClient, incidentId: string) {
  if (await tx.session.count({ where: { id: incidentId, status: { notIn: ["Closed", "Archived"] } } }) !== 1) throw new HttpError(409, "Release workflows in a closed incident are read-only");
}

async function nextOperationalId(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ value: bigint }>>`SELECT nextval('"ReleaseAction_operational_seq"') AS value`;
  return `REL-${new Date().getFullYear()}-${String(row!.value).padStart(6, "0")}`;
}

async function audit(tx: Prisma.TransactionClient, context: IncidentContext, actor: ReleaseActor, action: string, release: any, summary: string, data: Record<string, unknown>) {
  await tx.auditLog.create({ data: { action, entityType: "releaseAction", entityId: release.id, sessionId: context.incidentId, actorId: context.actorId, actorEmail: actor.email, summary, metadata: json({ releaseActionId: release.id, passengerRecordId: release.passengerRecordId, relationshipClaimId: release.relationshipClaimId, matchDecisionId: release.matchDecisionId, operationId: data.operationId, requestId: actor.requestId, ...data }) } });
}

async function timeline(tx: Prisma.TransactionClient, context: IncidentContext, actor: ReleaseActor, release: any, eventType: string, title: string, body: string, data: Record<string, unknown>) {
  const claim = release.relationshipClaimId ? await tx.relationshipClaim.findUnique({ where: { id: release.relationshipClaimId }, include: { familyRecord: { select: { caseId: true } } } }) : null;
  await tx.caseTimelineEvent.create({ data: { sessionId: context.incidentId, caseId: claim?.familyRecord.caseId, eventType, entityType: "releaseAction", entityId: release.id, title, body, metadata: json({ actionType: release.actionType, status: release.status, requestId: actor.requestId, ...data }), createdById: context.actorId } });
}

async function sourceForPrepare(tx: Prisma.TransactionClient, context: IncidentContext, matchDecisionId: string) {
  const decision = await tx.matchDecision.findFirst({
    where: { id: matchDecisionId, incidentId: context.incidentId },
    include: { relationshipClaim: true, passengerRecord: true, matchingRecord: true }
  });
  if (!decision) throw new HttpError(404, "Current MatchDecision not found");
  const valid = decision.decision === "CONFIRMED" && decision.validity === "CURRENT" && decision.isCurrent && decision.relationshipClaim.isCurrent && decision.relationshipClaim.status === "VERIFIED" && decision.claimVersion === decision.relationshipClaim.version && decision.passengerVersion === decision.passengerRecord.version;
  if (!valid) throw new HttpError(409, "Release preparation requires a current VERIFIED RelationshipClaim and current human CONFIRMED MatchDecision");
  return decision;
}

function mutationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code);
}

function queueEligibilitySql() {
  return Prisma.sql`COALESCE((
    claim."isCurrent" = true AND claim."status" = 'VERIFIED'
    AND claim."version" = action."relationshipClaimVersion"
    AND decision."decision" = 'CONFIRMED' AND decision."validity" = 'CURRENT' AND decision."isCurrent" = true
    AND decision."claimVersion" = claim."version" AND decision."passengerVersion" = passenger."version"
    AND passenger."version" = action."passengerVersion"
    AND (passenger."holdStatus" IS NULL OR passenger."holdStatus" = 'No hold')
    AND (matching."holdCheck" IS NULL OR matching."holdCheck" = 'No hold')
    AND identity_check."result" = 'PASS' AND identity_check."claimVersion" = claim."version" AND identity_check."passengerVersion" = passenger."version"
    AND hold_check."result" = 'PASS' AND hold_check."claimVersion" = claim."version" AND hold_check."passengerVersion" = passenger."version"
  ), false)`;
}

export function createPrismaReleaseRepository(client: PrismaClient): ReleaseRepository {
  async function result(tx: Prisma.TransactionClient, incidentId: string, id: string, idempotent = false): Promise<ReleaseMutationResult> {
    const row = await findAction(tx, incidentId, id);
    return { record: row ? actionRecord(row) : null, conflict: !row, idempotent };
  }

  async function recordCheck(context: IncidentContext, releaseActionId: string, input: RecordIdentityCheckInput | RecordHoldReviewInput, actor: ReleaseActor, type: "IDENTITY" | "HOLD_REVIEW") {
    const command = type === "IDENTITY" ? "IDENTITY_CHECK" : "HOLD_REVIEW";
    const values = type === "IDENTITY" ? [(input as RecordIdentityCheckInput).result, input.basis, (input as RecordIdentityCheckInput).evidenceReference ?? null] : [input.basis];
    const commandFingerprint = fingerprint(command, releaseActionId, values);
    try {
      return await client.$transaction(async (tx) => {
        const retryId = await operationRetry(tx, context.incidentId, input.operationId, commandFingerprint);
        if (retryId) return result(tx, context.incidentId, retryId, true);
        await assertOperationIdUnusedByCheck(tx, context.incidentId, input.operationId);
        await assertWritable(tx, context.incidentId);
        const existing = await findAction(tx, context.incidentId, releaseActionId);
        if (!existing) return { record: null, conflict: true };
        const current = actionRecord(existing);
        if (existing.status !== "PREPARED" || existing.version !== input.expectedVersion) return { record: null, conflict: true };
        if (current.preconditions.find((item) => item.key === "relationship")?.state !== "PASS" || current.preconditions.find((item) => item.key === "match")?.state !== "PASS" || current.preconditions.find((item) => item.key === "inputs")?.state !== "PASS") throw new HttpError(409, "Release inputs changed; cancel and prepare a new action before recording checks");
        const resultValue = type === "IDENTITY" ? (input as RecordIdentityCheckInput).result : noHold(existing.passengerRecord?.holdStatus) ? "PASS" : "FAIL";
        const changed = await tx.releaseAction.updateMany({ where: { id: releaseActionId, incidentId: context.incidentId, status: "PREPARED", version: input.expectedVersion }, data: { version: { increment: 1 } } });
        if (changed.count !== 1) return { record: null, conflict: true };
        const previous = await tx.releaseCheck.findFirst({ where: { incidentId: context.incidentId, releaseActionId, type, isCurrent: true }, orderBy: { checkedAt: "desc" } });
        if (previous) await tx.releaseCheck.update({ where: { id: previous.id }, data: { isCurrent: false, version: { increment: 1 } } });
        const check = await tx.releaseCheck.create({ data: { incidentId: context.incidentId, releaseActionId, type, result: resultValue, actorId: context.actorId, basis: input.basis, evidenceReference: type === "IDENTITY" ? (input as RecordIdentityCheckInput).evidenceReference : null, relationshipClaimId: existing.relationshipClaimId, claimVersion: existing.relationshipClaim?.version, matchDecisionId: existing.matchDecisionId, passengerVersion: existing.passengerRecord?.version, operationId: input.operationId, supersedesCheckId: previous?.id, requestId: actor.requestId } });
        await tx.releaseOperation.create({ data: { incidentId: context.incidentId, releaseActionId, operationId: input.operationId, command, commandFingerprint, resultVersion: input.expectedVersion + 1, requestId: actor.requestId } });
        const changedRelease = { ...existing, version: input.expectedVersion + 1 };
        await audit(tx, context, actor, type === "IDENTITY" ? "release_identity_check" : "release_hold_review", changedRelease, `${type === "IDENTITY" ? "Identity" : "Passenger hold"} check ${resultValue}`, { operationId: input.operationId, checkId: check.id, checkType: type, result: resultValue, basis: input.basis, claimVersion: existing.relationshipClaim?.version, passengerVersion: existing.passengerRecord?.version, beforeState: existing.status, afterState: existing.status });
        await timeline(tx, context, actor, changedRelease, "release_check", `${type === "IDENTITY" ? "Identity" : "Passenger hold"} check ${resultValue}`, input.basis, { checkType: type, result: resultValue });
        return result(tx, context.incidentId, releaseActionId);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (mutationConflict(error)) return { record: null, conflict: true };
      throw error;
    }
  }

  return {
    kind: "postgres",

    async listQueue(context, query) {
      const filters: Prisma.Sql[] = [Prisma.sql`action."incidentId" = ${context.incidentId}::uuid`];
      if (query.status) filters.push(Prisma.sql`action."status" = ${query.status}`);
      if (query.actionType) filters.push(Prisma.sql`action."actionType" = ${query.actionType}`);
      if (query.search) filters.push(Prisma.sql`(action."operationalId" ILIKE ${`%${query.search}%`} OR passenger."operationalId" ILIKE ${`%${query.search}%`} OR passenger."firstName" ILIKE ${`%${query.search}%`} OR passenger."lastName" ILIKE ${`%${query.search}%`} OR family."operationalId" ILIKE ${`%${query.search}%`} OR family."firstName" ILIKE ${`%${query.search}%`} OR family."lastName" ILIKE ${`%${query.search}%`})`);
      const eligible = queueEligibilitySql();
      if (query.eligibility === "eligible") filters.push(eligible);
      if (query.eligibility === "blocked") filters.push(Prisma.sql`NOT ${eligible}`);
      const direction = Prisma.raw(query.sortDirection === "asc" ? "ASC" : "DESC");
      const ids = await client.$queryRaw<Array<{ id: string; total: bigint }>>(Prisma.sql`
        SELECT action."id", count(*) OVER() AS total
        FROM "ReleaseAction" action
        LEFT JOIN "RelationshipClaim" claim ON claim."id" = action."relationshipClaimId"
        LEFT JOIN "FamilyRecord" family ON family."id" = claim."familyRecordId"
        LEFT JOIN "MatchDecision" decision ON decision."id" = action."matchDecisionId"
        LEFT JOIN "MatchingRecord" matching ON matching."id" = action."matchingRecordId"
        LEFT JOIN "PassengerRecord" passenger ON passenger."id" = action."passengerRecordId"
        LEFT JOIN "ReleaseCheck" identity_check ON identity_check."releaseActionId" = action."id" AND identity_check."type" = 'IDENTITY' AND identity_check."isCurrent" = true
        LEFT JOIN "ReleaseCheck" hold_check ON hold_check."releaseActionId" = action."id" AND hold_check."type" = 'HOLD_REVIEW' AND hold_check."isCurrent" = true
        WHERE ${Prisma.join(filters, " AND ")}
        ORDER BY action."updatedAt" ${direction}, action."id" ${direction}
        LIMIT ${query.limit} OFFSET ${query.offset}
      `);
      if (!ids.length) return { total: 0, data: [] };
      const rows = await client.releaseAction.findMany({ where: { id: { in: ids.map((item) => item.id) } }, include: actionInclude });
      const byId = new Map(rows.map((row) => [row.id, actionRecord(row)]));
      return { total: Number(ids[0]!.total), data: ids.map((item) => byId.get(item.id)!).filter(Boolean) };
    },

    async listCandidates(context, query) {
      const filters: Prisma.Sql[] = [Prisma.sql`decision."incidentId" = ${context.incidentId}::uuid`, Prisma.sql`decision."decision" = 'CONFIRMED'`, Prisma.sql`decision."validity" = 'CURRENT'`, Prisma.sql`decision."isCurrent" = true`, Prisma.sql`claim."isCurrent" = true`, Prisma.sql`claim."status" = 'VERIFIED'`];
      if (query.search) filters.push(Prisma.sql`(passenger."operationalId" ILIKE ${`%${query.search}%`} OR passenger."firstName" ILIKE ${`%${query.search}%`} OR passenger."lastName" ILIKE ${`%${query.search}%`} OR family."operationalId" ILIKE ${`%${query.search}%`} OR family."firstName" ILIKE ${`%${query.search}%`} OR family."lastName" ILIKE ${`%${query.search}%`})`);
      const eligible = Prisma.sql`(decision."claimVersion" = claim."version" AND decision."passengerVersion" = passenger."version" AND (passenger."holdStatus" IS NULL OR passenger."holdStatus" = 'No hold') AND (matching."holdCheck" IS NULL OR matching."holdCheck" = 'No hold'))`;
      if (query.eligibility === "eligible") filters.push(eligible);
      if (query.eligibility === "blocked") filters.push(Prisma.sql`NOT ${eligible}`);
      const direction = Prisma.raw(query.sortDirection === "asc" ? "ASC" : "DESC");
      const ids = await client.$queryRaw<Array<{ id: string; total: bigint }>>(Prisma.sql`
        SELECT decision."id", count(*) OVER() AS total
        FROM "MatchDecision" decision
        JOIN "RelationshipClaim" claim ON claim."id" = decision."relationshipClaimId"
        JOIN "FamilyRecord" family ON family."id" = claim."familyRecordId"
        JOIN "PassengerRecord" passenger ON passenger."id" = decision."passengerRecordId"
        LEFT JOIN "MatchingRecord" matching ON matching."id" = decision."matchingRecordId"
        WHERE ${Prisma.join(filters, " AND ")}
        ORDER BY family."lastName" ${direction}, passenger."lastName" ${direction}, decision."id" ${direction}
        LIMIT ${query.limit} OFFSET ${query.offset}
      `);
      if (!ids.length) return { total: 0, data: [] };
      const rows = await client.matchDecision.findMany({ where: { id: { in: ids.map((item) => item.id) } }, include: { relationshipClaim: { include: { familyRecord: true } }, passengerRecord: true, matchingRecord: { select: { holdCheck: true } } } });
      const mapped = new Map(rows.map((row) => {
        const blockers = [row.claimVersion === row.relationshipClaim.version ? null : "RelationshipClaim version changed", row.passengerVersion === row.passengerRecord.version ? null : "Passenger source changed", noHold(row.passengerRecord.holdStatus) ? null : `Active Passenger hold: ${row.passengerRecord.holdStatus}`, noHold(row.matchingRecord?.holdCheck) ? null : `Active Matching hold: ${row.matchingRecord?.holdCheck}`].filter((item): item is string => Boolean(item));
        const record: ReleaseCandidateRecord = { matchDecisionId: row.id, matchingRecordId: row.matchingRecordId, relationshipClaimId: row.relationshipClaimId, passengerRecordId: row.passengerRecordId, claimVersion: row.relationshipClaim.version, passengerVersion: row.passengerRecord.version, relationshipStatus: row.relationshipClaim.status, passengerHold: row.passengerRecord.holdStatus, eligible: blockers.length === 0, blockers, family: { operationalId: row.relationshipClaim.familyRecord.operationalId, firstName: row.relationshipClaim.familyRecord.firstName, lastName: row.relationshipClaim.familyRecord.lastName, relationshipType: row.relationshipClaim.claimedRelationshipType }, passenger: { operationalId: row.passengerRecord.operationalId, firstName: row.passengerRecord.firstName, lastName: row.passengerRecord.lastName, flightNumber: row.passengerRecord.flightNumber, version: row.passengerRecord.version } };
        return [row.id, record] as const;
      }));
      return { total: Number(ids[0]!.total), data: ids.map((item) => mapped.get(item.id)!).filter(Boolean) };
    },

    async getContext(context, releaseActionId) {
      const row = await findAction(client, context.incidentId, releaseActionId);
      return row ? actionRecord(row) : null;
    },

    async prepare(context, input, actor) {
      const commandFingerprint = fingerprint("PREPARE", input.matchDecisionId, [input.actionType, input.releaseDestination ?? null, input.receivingParty ?? null, input.transportMode ?? null, input.notes ?? null]);
      try {
        return await client.$transaction(async (tx) => {
          const retryId = await operationRetry(tx, context.incidentId, input.operationId, commandFingerprint);
          if (retryId) return result(tx, context.incidentId, retryId, true);
          await assertOperationIdUnusedByCheck(tx, context.incidentId, input.operationId);
          await assertWritable(tx, context.incidentId);
          const source = await sourceForPrepare(tx, context, input.matchDecisionId);
          const existingControlledOutcome = await tx.releaseAction.count({ where: { incidentId: context.incidentId, relationshipClaimId: source.relationshipClaimId, matchDecisionId: source.id, actionType: input.actionType, status: { in: ["PREPARED", "AUTHORIZED", "COMPLETED"] } } });
          if (existingControlledOutcome > 0) return { record: null, conflict: true };
          const release = await tx.releaseAction.create({ data: { operationalId: await nextOperationalId(tx), incidentId: context.incidentId, actionType: input.actionType, status: "PREPARED", relationshipClaimId: source.relationshipClaimId, matchDecisionId: source.id, matchingRecordId: source.matchingRecordId, passengerRecordId: source.passengerRecordId, relationshipClaimVersion: source.relationshipClaim.version, passengerVersion: source.passengerRecord.version, releaseDestination: input.releaseDestination, receivingParty: input.receivingParty, transportMode: input.transportMode, notes: input.notes, preparedById: context.actorId } });
          await tx.releaseOperation.create({ data: { incidentId: context.incidentId, releaseActionId: release.id, operationId: input.operationId, command: "PREPARE", commandFingerprint, resultVersion: 1, requestId: actor.requestId } });
          await audit(tx, context, actor, "prepare_release", release, `${input.actionType} ${release.operationalId} prepared`, { operationId: input.operationId, claimVersion: source.relationshipClaim.version, passengerVersion: source.passengerRecord.version, beforeState: null, afterState: "PREPARED" });
          await timeline(tx, context, actor, release, "release", `${input.actionType} ${release.operationalId} prepared`, input.notes ?? "Release action prepared for independent checks", { status: "PREPARED" });
          return result(tx, context.incidentId, release.id);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (mutationConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },

    recordIdentityCheck(context, releaseActionId, input, actor) {
      return recordCheck(context, releaseActionId, input, actor, "IDENTITY");
    },

    recordHoldReview(context, releaseActionId, input, actor) {
      return recordCheck(context, releaseActionId, input, actor, "HOLD_REVIEW");
    },

    async authorize(context, releaseActionId, input, actor) {
      const commandFingerprint = fingerprint("AUTHORIZE", releaseActionId, [input.reason]);
      try {
        return await client.$transaction(async (tx) => {
          const retryId = await operationRetry(tx, context.incidentId, input.operationId, commandFingerprint);
          if (retryId) return result(tx, context.incidentId, retryId, true);
          await assertOperationIdUnusedByCheck(tx, context.incidentId, input.operationId);
          await assertWritable(tx, context.incidentId);
          const existing = await findAction(tx, context.incidentId, releaseActionId);
          if (!existing) return { record: null, conflict: true };
          if (existing.version !== input.expectedVersion || existing.status !== "PREPARED") return { record: null, conflict: true };
          const evaluated = actionRecord(existing);
          if (!evaluated.canAuthorize) throw new HttpError(409, `Release authorization blocked: ${evaluated.blockers.join("; ")}`);
          const changed = await tx.releaseAction.updateMany({ where: { id: releaseActionId, incidentId: context.incidentId, status: "PREPARED", version: input.expectedVersion }, data: { status: "AUTHORIZED", version: { increment: 1 }, authorizedById: context.actorId, authorizedAt: new Date(), authorizationReason: input.reason, authorizedClaimVersion: existing.relationshipClaim?.version, authorizedPassengerVersion: existing.passengerRecord?.version } });
          if (changed.count !== 1) return { record: null, conflict: true };
          await tx.releaseOperation.create({ data: { incidentId: context.incidentId, releaseActionId, operationId: input.operationId, command: "AUTHORIZE", commandFingerprint, resultVersion: input.expectedVersion + 1, requestId: actor.requestId } });
          const changedRelease = { ...existing, status: "AUTHORIZED", version: input.expectedVersion + 1 };
          await audit(tx, context, actor, "authorize_release", changedRelease, `${existing.actionType} ${existing.operationalId} authorized`, { operationId: input.operationId, reason: input.reason, claimVersion: existing.relationshipClaim?.version, passengerVersion: existing.passengerRecord?.version, beforeState: "PREPARED", afterState: "AUTHORIZED" });
          await timeline(tx, context, actor, changedRelease, "release", `${existing.actionType} ${existing.operationalId} authorized`, input.reason, { status: "AUTHORIZED" });
          return result(tx, context.incidentId, releaseActionId);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (mutationConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },

    async complete(context, releaseActionId, input, actor) {
      const commandFingerprint = fingerprint("COMPLETE", releaseActionId, [input.reason]);
      try {
        return await client.$transaction(async (tx) => {
          const retryId = await operationRetry(tx, context.incidentId, input.operationId, commandFingerprint);
          if (retryId) return result(tx, context.incidentId, retryId, true);
          await assertOperationIdUnusedByCheck(tx, context.incidentId, input.operationId);
          await assertWritable(tx, context.incidentId);
          const existing = await findAction(tx, context.incidentId, releaseActionId);
          if (!existing) return { record: null, conflict: true };
          if (existing.version !== input.expectedVersion || existing.status !== "AUTHORIZED") return { record: null, conflict: true };
          const evaluated = actionRecord(existing);
          if (!evaluated.canComplete) throw new HttpError(409, `Release completion blocked: ${evaluated.blockers.join("; ")}`);
          if (existing.actionType === "RELEASE" && !existing.receivingParty) throw new HttpError(400, "Receiving party is required to complete RELEASE");
          const changed = await tx.releaseAction.updateMany({ where: { id: releaseActionId, incidentId: context.incidentId, status: "AUTHORIZED", version: input.expectedVersion }, data: { status: "COMPLETED", version: { increment: 1 }, completedById: context.actorId, completedAt: new Date(), completionNotes: input.reason } });
          if (changed.count !== 1) return { record: null, conflict: true };
          await tx.releaseOperation.create({ data: { incidentId: context.incidentId, releaseActionId, operationId: input.operationId, command: "COMPLETE", commandFingerprint, resultVersion: input.expectedVersion + 1, requestId: actor.requestId } });
          const changedRelease = { ...existing, status: "COMPLETED", version: input.expectedVersion + 1 };
          await audit(tx, context, actor, "complete_release", changedRelease, `${existing.actionType} ${existing.operationalId} completed`, { operationId: input.operationId, reason: input.reason, claimVersion: existing.relationshipClaim?.version, passengerVersion: existing.passengerRecord?.version, beforeState: "AUTHORIZED", afterState: "COMPLETED" });
          await timeline(tx, context, actor, changedRelease, existing.actionType === "RELEASE" ? "release" : "reunification", `${existing.actionType} ${existing.operationalId} completed`, input.reason, { status: "COMPLETED" });
          return result(tx, context.incidentId, releaseActionId);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (mutationConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },

    async cancel(context, releaseActionId, input, actor) {
      const commandFingerprint = fingerprint("CANCEL", releaseActionId, [input.reason]);
      try {
        return await client.$transaction(async (tx) => {
          const retryId = await operationRetry(tx, context.incidentId, input.operationId, commandFingerprint);
          if (retryId) return result(tx, context.incidentId, retryId, true);
          await assertOperationIdUnusedByCheck(tx, context.incidentId, input.operationId);
          await assertWritable(tx, context.incidentId);
          const existing = await findAction(tx, context.incidentId, releaseActionId);
          if (!existing) return { record: null, conflict: true };
          if (existing.version !== input.expectedVersion || !["PREPARED", "AUTHORIZED"].includes(existing.status)) return { record: null, conflict: true };
          const changed = await tx.releaseAction.updateMany({ where: { id: releaseActionId, incidentId: context.incidentId, status: { in: ["PREPARED", "AUTHORIZED"] }, version: input.expectedVersion }, data: { status: "CANCELLED", version: { increment: 1 }, cancelledById: context.actorId, cancelledAt: new Date(), cancelReason: input.reason } });
          if (changed.count !== 1) return { record: null, conflict: true };
          await tx.releaseOperation.create({ data: { incidentId: context.incidentId, releaseActionId, operationId: input.operationId, command: "CANCEL", commandFingerprint, resultVersion: input.expectedVersion + 1, requestId: actor.requestId } });
          const changedRelease = { ...existing, status: "CANCELLED", version: input.expectedVersion + 1 };
          await audit(tx, context, actor, "cancel_release", changedRelease, `${existing.actionType} ${existing.operationalId} cancelled`, { operationId: input.operationId, reason: input.reason, beforeState: existing.status, afterState: "CANCELLED" });
          await timeline(tx, context, actor, changedRelease, "release", `${existing.actionType} ${existing.operationalId} cancelled`, input.reason, { status: "CANCELLED" });
          return result(tx, context.incidentId, releaseActionId);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (mutationConflict(error)) return { record: null, conflict: true };
        throw error;
      }
    },

    async listCompatibility(context, query) {
      const result = await this.listQueue(context, query);
      return { total: result.total, data: result.data.map(compatibility) };
    }
  };
}

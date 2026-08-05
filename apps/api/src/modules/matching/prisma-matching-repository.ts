import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { HttpError } from "../../errors.js";
import type { MatchingRepository } from "./matching-repository.js";
import type { MatchDecisionRecord, MatchingActor, MatchingCompatibilityRecord, MatchingContextRecord, MatchingPassengerProjection, MatchingQueueItem, MatchSignal, MatchSuggestionRecord } from "./matching-types.js";

const algorithm = "zpp-deterministic-candidate";
const algorithmVersion = "1.0.0";

const familyProjection = { select: { id: true, operationalId: true, firstName: true, lastName: true, verificationStatus: true, verifiedRelationship: true, caseId: true } } as const;
const passengerProjection = { select: { id: true, operationalId: true, firstName: true, lastName: true, dateOfBirth: true, flightNumber: true, route: true, seat: true, conditionStatus: true, holdStatus: true, version: true, caseId: true } } as const;

function metadata(value: Record<string, unknown>): Prisma.InputJsonValue {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Prisma.InputJsonObject;
}

function signals(value: Prisma.JsonValue): MatchSignal[] {
  return Array.isArray(value) ? value.filter((item): item is MatchSignal => Boolean(item && typeof item === "object" && "key" in item && "label" in item)) : [];
}

function passenger(row: { id: string; operationalId: string; firstName: string; lastName: string; dateOfBirth: Date | null; flightNumber: string | null; route: string | null; seat: string | null; conditionStatus: string; holdStatus: string; version: number }): MatchingPassengerProjection {
  return row;
}

function suggestion(row: any): MatchSuggestionRecord {
  const { passengerRecord, positiveSignals, conflicts, ...record } = row;
  return { ...record, positiveSignals: signals(positiveSignals), conflicts: signals(conflicts), status: record.status as MatchSuggestionRecord["status"], passenger: passengerRecord ? passenger(passengerRecord) : undefined };
}

function decision(row: any, currentClaimVersion?: number, currentPassengerVersion?: number, claimIsCurrent = true): MatchDecisionRecord {
  const { decisionBy, ...record } = row;
  const stored = record.validity as MatchDecisionRecord["validity"];
  const effectiveValidity = stored === "CURRENT" && record.isCurrent && (!claimIsCurrent || record.claimVersion !== currentClaimVersion || record.passengerVersion !== currentPassengerVersion) ? "STALE" : stored;
  return { ...record, decision: record.decision as MatchDecisionRecord["decision"], validity: stored, effectiveValidity, decisionByDisplayName: decisionBy?.displayName ?? null };
}

function claimProjection(row: any) {
  const { familyRecord, ...claim } = row;
  return {
    ...claim,
    family: {
      id: familyRecord.id,
      operationalId: familyRecord.operationalId,
      firstName: familyRecord.firstName,
      lastName: familyRecord.lastName,
      verificationStatus: familyRecord.verificationStatus,
      verifiedRelationship: familyRecord.verifiedRelationship
    }
  };
}

async function assertWritable(tx: Prisma.TransactionClient, incidentId: string) {
  if (await tx.session.count({ where: { id: incidentId, status: { notIn: ["Closed", "Archived"] } } }) !== 1) throw new HttpError(409, "Matching in a closed incident is read-only");
}

async function operationalId(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ value: bigint }>>`SELECT nextval('"MatchingRecord_operational_seq"') AS value`;
  return `MAT-${new Date().getFullYear()}-${String(row!.value).padStart(6, "0")}`;
}

async function audit(tx: Prisma.TransactionClient, context: { incidentId: string; actorId: string }, actor: MatchingActor, action: string, entityId: string, summary: string, data: Record<string, unknown>) {
  await tx.auditLog.create({ data: { action, entityType: "matchDecision", entityId, sessionId: context.incidentId, actorId: context.actorId, actorEmail: actor.email, summary, metadata: metadata({ ...data, requestId: actor.requestId }) } });
}

async function timeline(tx: Prisma.TransactionClient, context: { incidentId: string; actorId: string }, actor: MatchingActor, claim: { id: string; familyRecord: { caseId: string | null } }, entityId: string, title: string, body: string, data: Record<string, unknown>) {
  await tx.caseTimelineEvent.create({ data: { sessionId: context.incidentId, caseId: claim.familyRecord.caseId, eventType: "matching", entityType: "matchDecision", entityId, title, body, metadata: metadata({ ...data, requestId: actor.requestId }), createdById: context.actorId } });
}

const currentClaimInclude = {
  familyRecord: familyProjection
} satisfies Prisma.RelationshipClaimInclude;

async function currentClaim(db: PrismaClient | Prisma.TransactionClient, incidentId: string, claimId: string) {
  return db.relationshipClaim.findFirst({ where: { id: claimId, incidentId, isCurrent: true }, include: currentClaimInclude });
}

async function queueItem(db: PrismaClient | Prisma.TransactionClient, incidentId: string, claimId: string): Promise<MatchingQueueItem | null> {
  const claim = await currentClaim(db, incidentId, claimId);
  if (!claim) return null;
  const [suggestionCount, top, accepted] = await Promise.all([
    db.matchSuggestion.count({ where: { incidentId, relationshipClaimId: claimId, isCurrent: true, status: { in: ["ACTIVE", "USED"] } } }),
    db.matchSuggestion.findFirst({ where: { incidentId, relationshipClaimId: claimId, isCurrent: true, status: { in: ["ACTIVE", "USED"] } }, orderBy: [{ score: "desc" }, { generatedAt: "desc" }], include: { passengerRecord: passengerProjection } }),
    db.matchDecision.findFirst({ where: { incidentId, relationshipClaimId: claimId, decision: "CONFIRMED", isCurrent: true }, orderBy: { decidedAt: "desc" }, include: { decisionBy: { select: { displayName: true } }, passengerRecord: { select: { version: true } } } })
  ]);
  const current = accepted ? decision(accepted, claim.version, accepted.passengerRecord.version, claim.isCurrent) : null;
  const state = current ? (current.effectiveValidity === "CURRENT" ? "CONFIRMED" : "STALE") : suggestionCount ? "SUGGESTED" : "UNMATCHED";
  return { relationshipClaim: claimProjection(claim), state, suggestionCount, topSuggestion: top ? suggestion(top) : null, currentDecision: current, updatedAt: accepted?.decidedAt ?? top?.generatedAt ?? claim.updatedAt };
}

async function contextRecord(db: PrismaClient | Prisma.TransactionClient, incidentId: string, claimId: string): Promise<MatchingContextRecord | null> {
  const item = await queueItem(db, incidentId, claimId);
  if (!item) return null;
  const [suggestions, decisions] = await Promise.all([
    db.matchSuggestion.findMany({ where: { incidentId, relationshipClaimId: claimId }, orderBy: [{ isCurrent: "desc" }, { score: "desc" }, { generatedAt: "desc" }], take: 200, include: { passengerRecord: passengerProjection } }),
    db.matchDecision.findMany({ where: { incidentId, relationshipClaimId: claimId }, orderBy: { decidedAt: "desc" }, include: { decisionBy: { select: { displayName: true } }, passengerRecord: { select: { version: true } } } })
  ]);
  return { ...item, suggestions: suggestions.map(suggestion), decisionHistory: decisions.map((row) => decision(row, item.relationshipClaim.version, row.passengerRecord.version, item.relationshipClaim.isCurrent)) };
}

function same(left?: string | null, right?: string | null) {
  return Boolean(left?.trim() && right?.trim() && left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase());
}

function explain(claim: any, candidate: any) {
  const checks = [
    { key: "linked-passenger", label: "Passenger explicitly linked in the current claim", available: Boolean(claim.passengerRecordId), matches: claim.passengerRecordId === candidate.id },
    { key: "last-name", label: "Passenger surname matches the claim", available: Boolean(claim.claimedPassengerLastName), matches: same(claim.claimedPassengerLastName, candidate.lastName) },
    { key: "first-name", label: "Passenger first name matches the claim", available: Boolean(claim.claimedPassengerFirstName), matches: same(claim.claimedPassengerFirstName, candidate.firstName) },
    { key: "flight", label: "Flight matches the claim", available: Boolean(claim.claimedPassengerFlight), matches: same(claim.claimedPassengerFlight, candidate.flightNumber) },
    { key: "case", label: "Operational case aligns", available: Boolean(claim.familyRecord.caseId && candidate.caseId), matches: same(claim.familyRecord.caseId, candidate.caseId) }
  ].filter((item) => item.available);
  const positiveSignals = checks.filter((item) => item.matches).map(({ key, label }) => ({ key, label }));
  const conflicts = checks.filter((item) => !item.matches).map(({ key, label }) => ({ key, label: label.replace("matches", "differs from") }));
  const score = checks.length ? Number((positiveSignals.length / checks.length).toFixed(4)) : 0;
  const eligible = claim.passengerRecordId === candidate.id || (same(claim.claimedPassengerLastName, candidate.lastName) && (same(claim.claimedPassengerFirstName, candidate.firstName) || same(claim.claimedPassengerFlight, candidate.flightNumber)));
  return { positiveSignals, conflicts, score, eligible };
}

function fingerprint(action: string, claimId: string, passengerId: string, suggestionId?: string | null) {
  return [action, claimId, passengerId, suggestionId ?? "manual"].join(":");
}

async function idempotent(tx: Prisma.TransactionClient, incidentId: string, operationId: string, expectedFingerprint: string) {
  const existing = await tx.matchDecision.findUnique({ where: { incidentId_operationId: { incidentId, operationId } } });
  if (!existing) return false;
  if (existing.commandFingerprint !== expectedFingerprint) throw new HttpError(409, "operationId was already used for a different matching command");
  return true;
}

const compatibilityInclude = {
  relationshipClaim: { include: { familyRecord: familyProjection } },
  passengerRecord: passengerProjection,
  suggestion: true,
  decisions: { where: { decision: "CONFIRMED", isCurrent: true }, orderBy: { decidedAt: "desc" as const }, take: 1, include: { decisionBy: { select: { displayName: true } } } },
  releases: { where: { status: "Completed" }, orderBy: { completedAt: "desc" as const }, take: 1 }
} satisfies Prisma.MatchingRecordInclude;

function compatibility(row: any): MatchingCompatibilityRecord {
  const claim = row.relationshipClaim;
  const pax = row.passengerRecord;
  const accepted = row.decisions[0];
  const currentMatch = Boolean(accepted && claim?.isCurrent && accepted.claimVersion === claim.version && accepted.passengerVersion === pax?.version && accepted.validity === "CURRENT");
  const stale = Boolean(accepted && !currentMatch);
  const relationshipVerified = claim?.status === "VERIFIED";
  const blockers = [
    relationshipVerified ? null : "Relationship claim is not verified",
    currentMatch ? null : stale ? "Match decision is stale" : "No current confirmed match",
    pax?.holdStatus && pax.holdStatus !== "No hold" ? `Passenger hold: ${pax.holdStatus}` : null,
    row.holdCheck && row.holdCheck !== "No hold" ? `Matching hold: ${row.holdCheck}` : null
  ].filter((item): item is string => Boolean(item));
  const release = row.releases[0];
  const status = release ? (release.actionType === "Release" ? "Released" : "Reunited") : currentMatch ? "Verified match" : stale ? "Requires review" : row.status;
  const suggestionSignals = row.suggestion ? { algorithm: row.suggestion.algorithm, algorithmVersion: row.suggestion.algorithmVersion, positiveSignals: signals(row.suggestion.positiveSignals), conflicts: signals(row.suggestion.conflicts) } : null;
  return {
    id: row.id,
    operationalId: row.operationalId,
    sessionId: row.sessionId,
    caseId: row.caseId,
    familyRecordId: row.familyRecordId,
    passengerRecordId: row.passengerRecordId,
    relationshipClaimId: row.relationshipClaimId,
    suggestionId: row.suggestionId,
    status,
    matchScore: row.suggestion?.score ?? null,
    matchBasis: row.matchBasis,
    verificationChecklist: suggestionSignals,
    holdCheck: row.holdCheck,
    decisionNotes: accepted?.reason ?? row.decisionNotes,
    approvedById: accepted?.decisionById ?? null,
    approvedAt: accepted?.decidedAt ?? null,
    version: row.version,
    releaseEligibility: { relationshipVerification: relationshipVerified ? "VERIFIED" : "NOT_VERIFIED", matchDecision: currentMatch ? "CURRENT_CONFIRMED" : stale ? "STALE" : "NOT_CONFIRMED", passengerHold: pax?.holdStatus ?? "Unknown", passengerCondition: pax?.conditionStatus ?? "Unknown", eligible: blockers.length === 0, blockers },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function createPrismaMatchingRepository(client: PrismaClient): MatchingRepository {
  return {
    kind: "postgres",

    async listQueue(context, query) {
      const filters: Prisma.Sql[] = [
        Prisma.sql`rc."incidentId" = ${context.incidentId}::uuid`,
        Prisma.sql`rc."isCurrent" = true`
      ];
      if (query.relationshipStatus) filters.push(Prisma.sql`rc.status = ${query.relationshipStatus}`);
      if (query.search) filters.push(Prisma.sql`(
          fr."operationalId" ILIKE ${`%${query.search}%`} OR fr."firstName" ILIKE ${`%${query.search}%`} OR
          fr."lastName" ILIKE ${`%${query.search}%`} OR rc."claimedPassengerFirstName" ILIKE ${`%${query.search}%`} OR
          rc."claimedPassengerLastName" ILIKE ${`%${query.search}%`} OR rc."claimedPassengerFlight" ILIKE ${`%${query.search}%`}
        )`);
      const stateFilter = query.state ? Prisma.sql`WHERE q.state = ${query.state}` : Prisma.empty;
      const direction = Prisma.raw(query.sortDirection === "asc" ? "ASC" : "DESC");
      const order = query.sortBy === "claimant" ? Prisma.sql`q.claimant ${direction}, q.id ${direction}` : query.sortBy === "state" ? Prisma.sql`q.state ${direction}, q.id ${direction}` : Prisma.sql`q."updatedAt" ${direction}, q.id ${direction}`;
      const queueCte = Prisma.sql`
        WITH q AS (
          SELECT rc.id, rc."updatedAt", fr."lastName" AS claimant,
            CASE
              WHEN EXISTS (
                SELECT 1 FROM "MatchDecision" md JOIN "PassengerRecord" pr ON pr.id = md."passengerRecordId"
                WHERE md."incidentId" = rc."incidentId" AND md."relationshipClaimId" = rc.id
                  AND md.decision = 'CONFIRMED' AND md."isCurrent" = true AND md.validity = 'CURRENT'
                  AND md."claimVersion" = rc.version AND md."passengerVersion" = pr.version
              ) THEN 'CONFIRMED'
              WHEN EXISTS (
                SELECT 1 FROM "MatchDecision" md WHERE md."incidentId" = rc."incidentId"
                  AND md."relationshipClaimId" = rc.id AND md.decision = 'CONFIRMED' AND md."isCurrent" = true
              ) THEN 'STALE'
              WHEN EXISTS (
                SELECT 1 FROM "MatchSuggestion" ms WHERE ms."incidentId" = rc."incidentId"
                  AND ms."relationshipClaimId" = rc.id AND ms."isCurrent" = true AND ms.status IN ('ACTIVE', 'USED')
              ) THEN 'SUGGESTED'
              ELSE 'UNMATCHED'
            END AS state
          FROM "RelationshipClaim" rc
          JOIN "FamilyRecord" fr ON fr.id = rc."familyRecordId"
          WHERE ${Prisma.join(filters, " AND ")}
        )`;
      const [countRows, pageRows] = await Promise.all([
        client.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`${queueCte} SELECT COUNT(*) AS total FROM q ${stateFilter}`),
        client.$queryRaw<Array<{ id: string }>>(Prisma.sql`${queueCte} SELECT q.id FROM q ${stateFilter} ORDER BY ${order} LIMIT ${query.limit} OFFSET ${query.offset}`)
      ]);
      const data = (await Promise.all(pageRows.map((row) => queueItem(client, context.incidentId, row.id)))).filter((item): item is MatchingQueueItem => Boolean(item));
      return { total: Number(countRows[0]?.total ?? 0), data };
    },

    getContext: (context, claimId) => contextRecord(client, context.incidentId, claimId),

    async listSuggestions(context, claimId, query) {
      if (!await currentClaim(client, context.incidentId, claimId)) return { total: 0, data: [] };
      const where: Prisma.MatchSuggestionWhereInput = { incidentId: context.incidentId, relationshipClaimId: claimId, status: query.status, conflicts: query.hasConflicts === undefined ? undefined : query.hasConflicts ? { not: [] } : { equals: [] } };
      const [total, rows] = await Promise.all([client.matchSuggestion.count({ where }), client.matchSuggestion.findMany({ where, take: query.limit, skip: query.offset, orderBy: [{ score: query.sortDirection }, { generatedAt: "desc" }], include: { passengerRecord: passengerProjection } })]);
      return { total, data: rows.map(suggestion) };
    },

    async generateSuggestions(context, claimId, input, actor) {
      await client.$transaction(async (tx) => {
        await assertWritable(tx, context.incidentId);
        const claim = await currentClaim(tx, context.incidentId, claimId);
        if (!claim) throw new HttpError(404, "Current relationship claim not found");
        if (claim.version !== input.expectedClaimVersion) throw new HttpError(409, "Relationship claim changed before suggestions were generated");
        const candidateFilters: Prisma.PassengerRecordWhereInput[] = [
          claim.passengerRecordId ? { id: claim.passengerRecordId } : undefined,
          claim.claimedPassengerLastName ? { lastName: { equals: claim.claimedPassengerLastName, mode: "insensitive" } } : undefined,
          claim.claimedPassengerFlight ? { flightNumber: { equals: claim.claimedPassengerFlight, mode: "insensitive" } } : undefined,
          claim.familyRecord.caseId ? { caseId: claim.familyRecord.caseId } : undefined
        ].filter(Boolean) as Prisma.PassengerRecordWhereInput[];
        const candidates = candidateFilters.length ? await tx.passengerRecord.findMany({ where: { sessionId: context.incidentId, OR: candidateFilters }, take: 200, orderBy: [{ lastName: "asc" }, { id: "asc" }] }) : [];
        const ranked = candidates.map((candidate) => ({ candidate, explanation: explain(claim, candidate) })).filter((item) => item.explanation.eligible).sort((a, b) => b.explanation.score - a.explanation.score).slice(0, 100);
        await tx.matchSuggestion.updateMany({ where: { incidentId: context.incidentId, relationshipClaimId: claimId, isCurrent: true }, data: { isCurrent: false, status: "OBSOLETE", version: { increment: 1 } } });
        const generationId = randomUUID();
        if (ranked.length) await tx.matchSuggestion.createMany({ data: ranked.map(({ candidate, explanation }) => ({ id: randomUUID(), incidentId: context.incidentId, relationshipClaimId: claimId, passengerRecordId: candidate.id, score: explanation.score, positiveSignals: explanation.positiveSignals as Prisma.InputJsonValue, conflicts: explanation.conflicts as Prisma.InputJsonValue, algorithm, algorithmVersion, generationId, claimVersion: claim.version, passengerVersion: candidate.version })) });
        await audit(tx, context, actor, "generate_match_suggestions", claimId, `Generated ${ranked.length} matching suggestions`, { relationshipClaimId: claimId, generationId, algorithm, algorithmVersion, candidatePoolSize: candidates.length, suggestionCount: ranked.length, claimVersion: claim.version });
      });
      return this.listSuggestions(context, claimId, { limit: 200, offset: 0, sortDirection: "desc", status: "ACTIVE" });
    },

    async listCandidates(context, claimId, query) {
      if (!await currentClaim(client, context.incidentId, claimId)) return { total: 0, data: [] };
      const where: Prisma.PassengerRecordWhereInput = { sessionId: context.incidentId, OR: query.search ? ["operationalId", "firstName", "lastName", "flightNumber", "route", "seat", "pnr", "ticketNumber"].map((field) => ({ [field]: { contains: query.search, mode: "insensitive" } })) : undefined };
      const [total, rows] = await Promise.all([client.passengerRecord.count({ where }), client.passengerRecord.findMany({ where, take: query.limit, skip: query.offset, orderBy: [{ lastName: query.sortDirection }, { id: query.sortDirection }], select: passengerProjection.select })]);
      return { total, data: rows.map(passenger) };
    },

    async confirm(context, claimId, input, actor) {
      try {
        const wasIdempotent = await client.$transaction(async (tx) => {
          const command = fingerprint("CONFIRMED", claimId, input.passengerRecordId, input.suggestionId);
          if (await idempotent(tx, context.incidentId, input.operationId, command)) return true;
          await assertWritable(tx, context.incidentId);
          const claim = await currentClaim(tx, context.incidentId, claimId);
          if (!claim) throw new HttpError(404, "Current relationship claim not found");
          const pax = await tx.passengerRecord.findFirst({ where: { id: input.passengerRecordId, sessionId: context.incidentId } });
          if (!pax) throw new HttpError(409, "Passenger and relationship claim must belong to the same incident");
          if (claim.version !== input.expectedClaimVersion || pax.version !== input.expectedPassengerVersion) throw new HttpError(409, "Matching input changed before the decision");
          const source = input.suggestionId ? await tx.matchSuggestion.findFirst({ where: { id: input.suggestionId, incidentId: context.incidentId, relationshipClaimId: claimId, passengerRecordId: pax.id, isCurrent: true, status: "ACTIVE" } }) : null;
          if (input.suggestionId && !source) throw new HttpError(409, "The selected suggestion is no longer current");
          const previous = await tx.matchDecision.findFirst({ where: { incidentId: context.incidentId, relationshipClaimId: claimId, decision: "CONFIRMED", isCurrent: true }, include: { passengerRecord: { select: { version: true } } } });
          if (previous && previous.claimVersion === claim.version && previous.passengerVersion === previous.passengerRecord.version) throw new HttpError(409, "This claim already has a current confirmed Passenger match");
          if (previous) await tx.matchDecision.update({ where: { id: previous.id }, data: { isCurrent: false, validity: "SUPERSEDED" } });
          const record = await tx.matchingRecord.create({ data: { operationalId: await operationalId(tx), sessionId: context.incidentId, caseId: claim.familyRecord.caseId, familyRecordId: claim.familyRecordId, passengerRecordId: pax.id, relationshipClaimId: claim.id, suggestionId: source?.id ?? null, status: "Verified match", matchScore: source?.score ?? null, matchBasis: source ? `Suggestion ${source.algorithm}/${source.algorithmVersion} reviewed by a human` : "Manual Passenger match confirmed by a human", verificationChecklist: source ? metadata({ algorithm: source.algorithm, algorithmVersion: source.algorithmVersion, positiveSignals: source.positiveSignals, conflicts: source.conflicts }) : metadata({ source: "manual" }), holdCheck: "No hold", decisionNotes: input.reason, approvedById: context.actorId, approvedAt: new Date(), createdById: context.actorId, updatedById: context.actorId } });
          const created = await tx.matchDecision.create({ data: { incidentId: context.incidentId, relationshipClaimId: claim.id, passengerRecordId: pax.id, matchingRecordId: record.id, suggestionId: source?.id ?? null, decision: "CONFIRMED", reason: input.reason, validity: "CURRENT", isCurrent: true, claimVersion: claim.version, passengerVersion: pax.version, operationId: input.operationId, commandFingerprint: command, decisionById: context.actorId, requestId: actor.requestId, supersedesDecisionId: previous?.id ?? null } });
          if (source) await tx.matchSuggestion.update({ where: { id: source.id }, data: { status: "USED", version: { increment: 1 } } });
          const common = { relationshipClaimId: claim.id, passengerRecordId: pax.id, suggestionId: source?.id ?? null, decisionId: created.id, result: "CONFIRMED", reason: input.reason, algorithm: source?.algorithm, algorithmVersion: source?.algorithmVersion, score: source?.score, claimVersion: claim.version, passengerVersion: pax.version, operationId: input.operationId };
          await audit(tx, context, actor, source ? "confirm_suggested_match" : "confirm_manual_match", created.id, `Passenger match confirmed for ${claim.familyRecord.operationalId}`, common);
          await timeline(tx, context, actor, claim, created.id, source ? "Suggested Passenger match confirmed" : "Manual Passenger match confirmed", input.reason, common);
          return false;
        });
        return { record: await contextRecord(client, context.incidentId, claimId), conflict: false, idempotent: wasIdempotent };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) return { record: null, conflict: true };
        throw error;
      }
    },

    async reject(context, claimId, input, actor) {
      try {
        const wasIdempotent = await client.$transaction(async (tx) => {
          const command = fingerprint("REJECTED", claimId, input.passengerRecordId, input.suggestionId);
          if (await idempotent(tx, context.incidentId, input.operationId, command)) return true;
          await assertWritable(tx, context.incidentId);
          const claim = await currentClaim(tx, context.incidentId, claimId);
          const pax = await tx.passengerRecord.findFirst({ where: { id: input.passengerRecordId, sessionId: context.incidentId } });
          if (!claim || !pax) throw new HttpError(409, "Suggestion links must belong to the current incident");
          if (claim.version !== input.expectedClaimVersion || pax.version !== input.expectedPassengerVersion) throw new HttpError(409, "Matching input changed before the decision");
          const changed = await tx.matchSuggestion.updateMany({ where: { id: input.suggestionId, incidentId: context.incidentId, relationshipClaimId: claimId, passengerRecordId: pax.id, version: input.expectedSuggestionVersion, isCurrent: true, status: "ACTIVE" }, data: { status: "REJECTED", isCurrent: false, version: { increment: 1 } } });
          if (changed.count !== 1) throw new HttpError(409, "The selected suggestion is no longer current");
          const created = await tx.matchDecision.create({ data: { incidentId: context.incidentId, relationshipClaimId: claim.id, passengerRecordId: pax.id, suggestionId: input.suggestionId, decision: "REJECTED", reason: input.reason, validity: "HISTORICAL", isCurrent: false, claimVersion: claim.version, passengerVersion: pax.version, operationId: input.operationId, commandFingerprint: command, decisionById: context.actorId, requestId: actor.requestId } });
          await audit(tx, context, actor, "reject_match_suggestion", created.id, `Matching suggestion rejected for ${claim.familyRecord.operationalId}`, { relationshipClaimId: claim.id, passengerRecordId: pax.id, suggestionId: input.suggestionId, decisionId: created.id, result: "REJECTED", reason: input.reason, claimVersion: claim.version, passengerVersion: pax.version, operationId: input.operationId });
          return false;
        });
        return { record: await contextRecord(client, context.incidentId, claimId), conflict: false, idempotent: wasIdempotent };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) return { record: null, conflict: true };
        throw error;
      }
    },

    async invalidate(context, claimId, input, actor) {
      try {
        const wasIdempotent = await client.$transaction(async (tx) => {
          const target = await tx.matchDecision.findFirst({ where: { id: input.decisionId, incidentId: context.incidentId, relationshipClaimId: claimId, decision: "CONFIRMED" }, include: { matchingRecord: true } });
          const passengerId = target?.passengerRecordId ?? "missing";
          const command = fingerprint("INVALIDATED", claimId, passengerId, input.decisionId);
          if (await idempotent(tx, context.incidentId, input.operationId, command)) return true;
          await assertWritable(tx, context.incidentId);
          const claim = await currentClaim(tx, context.incidentId, claimId);
          const existing = target?.isCurrent ? target : null;
          if (!claim || !existing) throw new HttpError(409, "The confirmed match is no longer current");
          const pax = await tx.passengerRecord.findFirst({ where: { id: existing.passengerRecordId, sessionId: context.incidentId } });
          if (!pax || claim.version !== input.expectedClaimVersion || pax.version !== input.expectedPassengerVersion) throw new HttpError(409, "Matching input changed before invalidation");
          const changed = await tx.matchDecision.updateMany({ where: { id: existing.id, isCurrent: true, validity: "CURRENT" }, data: { isCurrent: false, validity: "SUPERSEDED" } });
          if (changed.count !== 1) throw new HttpError(409, "The confirmed match is no longer current");
          if (existing.matchingRecordId) await tx.matchingRecord.update({ where: { id: existing.matchingRecordId }, data: { status: "Potential match", decisionNotes: input.reason, approvedById: null, approvedAt: null, version: { increment: 1 }, updatedById: context.actorId } });
          const created = await tx.matchDecision.create({ data: { incidentId: context.incidentId, relationshipClaimId: claim.id, passengerRecordId: pax.id, matchingRecordId: existing.matchingRecordId, suggestionId: existing.suggestionId, decision: "INVALIDATED", reason: input.reason, validity: "HISTORICAL", isCurrent: false, claimVersion: claim.version, passengerVersion: pax.version, operationId: input.operationId, commandFingerprint: command, decisionById: context.actorId, requestId: actor.requestId, supersedesDecisionId: existing.id } });
          const common = { relationshipClaimId: claim.id, passengerRecordId: pax.id, previousDecisionId: existing.id, decisionId: created.id, result: "INVALIDATED", reason: input.reason, claimVersion: claim.version, passengerVersion: pax.version, operationId: input.operationId };
          await audit(tx, context, actor, "invalidate_match_decision", created.id, `Passenger match invalidated for ${claim.familyRecord.operationalId}`, common);
          await timeline(tx, context, actor, claim, created.id, "Passenger match invalidated", input.reason, common);
          return false;
        });
        return { record: await contextRecord(client, context.incidentId, claimId), conflict: false, idempotent: wasIdempotent };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) return { record: null, conflict: true };
        throw error;
      }
    },

    async setHold(context, matchingRecordId, input, actor) {
      const row = await client.matchingRecord.findFirst({ where: { id: matchingRecordId, sessionId: context.incidentId } });
      if (!row) return { record: null, conflict: false };
      const changed = await client.$transaction(async (tx) => {
        await assertWritable(tx, context.incidentId);
        const result = await tx.matchingRecord.updateMany({ where: { id: matchingRecordId, sessionId: context.incidentId, version: input.expectedVersion }, data: { holdCheck: input.holdCheck, decisionNotes: input.reason, version: { increment: 1 }, updatedById: context.actorId } });
        if (result.count !== 1) return false;
        await audit(tx, context, actor, input.holdCheck === "No hold" ? "clear_matching_hold" : "place_matching_hold", matchingRecordId, input.holdCheck === "No hold" ? "Matching hold cleared" : "Matching hold applied", { matchingRecordId, holdCheck: input.holdCheck, reason: input.reason, versionBefore: input.expectedVersion, versionAfter: input.expectedVersion + 1 });
        return true;
      });
      if (!changed) return { record: null, conflict: true };
      return { record: await this.getReleaseCompatibility(context, matchingRecordId), conflict: false };
    },

    async listCompatibility(context, query) {
      const where: Prisma.MatchingRecordWhereInput = { sessionId: context.incidentId, status: query.status, OR: query.search ? [{ operationalId: { contains: query.search, mode: "insensitive" } }, { caseId: { contains: query.search, mode: "insensitive" } }] : undefined };
      const [total, rows] = await Promise.all([client.matchingRecord.count({ where }), client.matchingRecord.findMany({ where, take: query.limit, skip: query.offset, orderBy: [{ updatedAt: query.sortDirection }, { id: query.sortDirection }], include: compatibilityInclude })]);
      return { total, data: rows.filter((row) => row.relationshipClaim && row.passengerRecord).map(compatibility) };
    },

    async getReleaseCompatibility(context, matchingRecordId) {
      const row = await client.matchingRecord.findFirst({ where: { id: matchingRecordId, sessionId: context.incidentId }, include: compatibilityInclude });
      return row?.relationshipClaim && row.passengerRecord ? compatibility(row) : null;
    }
  };
}

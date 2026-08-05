import { randomUUID } from "node:crypto";
import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type { FamilyRepository } from "./family-repository.js";
import { normalizeEmail, normalizePhone } from "./family-service.js";
import type { FamilyActor, FamilyRecord } from "./family-types.js";

type Row = Record<string, any>;
type Sources = { families: Row[]; passengers: Row[]; importBatches: Row[]; auditLogs: Row[]; timeline: Row[]; users?: Row[]; now?: () => string };

function nextOperationalId(rows: Row[]) {
  const year = new Date().getFullYear();
  const stem = `FAM-${year}-`;
  const highest = rows.reduce((value, row) => {
    const match = String(row.operationalId ?? "").match(new RegExp(`^${stem}(\\d+)$`));
    return Math.max(value, match ? Number(match[1]) : 0);
  }, 0);
  return `${stem}${String(highest + 1).padStart(6, "0")}`;
}

export function createMemoryFamilyRepository(sources: Sources): FamilyRepository {
  const currentTime = sources.now ?? (() => new Date().toISOString());
  const claims: Row[] = [];
  const decisions: Row[] = [];

  function actorSnapshot(actor: FamilyActor) {
    return { id: actor.id, userId: actor.id, email: actor.email, displayName: actor.displayName, roles: actor.roles };
  }

  function ensureClaim(row: Row) {
    let claim = claims.find((item) => item.familyRecordId === row.id && item.isCurrent);
    if (!claim) {
      const status = row.verificationStatus === "Verified" ? "VERIFIED" : row.verificationStatus === "Disputed" || row.verificationStatus === "Rejected" ? "REJECTED" : "PENDING";
      claim = {
        id: `claim-memory-${row.id}`,
        incidentId: row.sessionId,
        familyRecordId: row.id,
        passengerRecordId: row.passengerRecordId ?? null,
        claimedRelationshipType: row.claimedRelationship ?? null,
        claimedPassengerFirstName: row.passengerFirstName ?? null,
        claimedPassengerLastName: row.passengerLastName ?? null,
        claimedPassengerFlight: row.passengerFlight ?? null,
        source: "LEGACY",
        status,
        isCurrent: true,
        version: Number(row.claimVersion ?? 1),
        claimedById: row.createdById ?? null,
        claimedAt: row.createdAt ?? currentTime(),
        supersededAt: null,
        createdAt: row.createdAt ?? currentTime(),
        updatedAt: row.updatedAt ?? currentTime()
      };
      claims.push(claim);
    }
    return claim;
  }

  function duplicateIds(row: Row) {
    if (!row.normalizedPhone && !row.normalizedEmail) return [];
    return sources.families
      .filter((candidate) => candidate.sessionId === row.sessionId && candidate.id !== row.id)
      .filter((candidate) => (row.normalizedPhone && candidate.normalizedPhone === row.normalizedPhone) || (row.normalizedEmail && candidate.normalizedEmail === row.normalizedEmail))
      .slice(0, 20)
      .map((candidate) => String(candidate.id));
  }

  function normalized(row: Row): FamilyRecord {
    row.version = Number(row.version ?? 1);
    row.normalizedPhone = row.normalizedPhone ?? normalizePhone(row.phone);
    row.normalizedEmail = row.normalizedEmail ?? normalizeEmail(row.email);
    if (row.verificationStatus === "Partially verified") row.verificationStatus = "Review required";
    if (row.verificationStatus === "Disputed") row.verificationStatus = "Rejected";
    const claim = ensureClaim(row);
    const claimDecisions = decisions.filter((item) => item.relationshipClaimId === claim.id).sort((a, b) => String(b.decisionAt).localeCompare(String(a.decisionAt)));
    const familyClaimIds = new Set(claims.filter((item) => item.familyRecordId === row.id).map((item) => item.id));
    const decisionHistory = decisions.filter((item) => familyClaimIds.has(item.relationshipClaimId)).sort((a, b) => String(b.decisionAt).localeCompare(String(a.decisionAt))).map((item) => ({ ...item, decisionByDisplayName: sources.users?.find((user) => user.id === item.decisionById)?.displayName ?? null }));
    return { ...row, currentClaim: { ...claim, decisions: claimDecisions.map((item) => ({ ...item, decisionByDisplayName: sources.users?.find((user) => user.id === item.decisionById)?.displayName ?? null })) }, decisionHistory, claimHistoryCount: familyClaimIds.size, potentialDuplicateIds: duplicateIds(row) } as FamilyRecord;
  }

  function find(context: IncidentContext, familyId: string) {
    return sources.families.find((row) => row.id === familyId && row.sessionId === context.incidentId);
  }

  function passengerInIncident(context: IncidentContext, passengerRecordId?: string | null) {
    return !passengerRecordId || sources.passengers.some((row) => row.id === passengerRecordId && row.sessionId === context.incidentId);
  }

  function audit(context: IncidentContext, actor: FamilyActor, row: Row, action: string, summary: string, metadata: Row) {
    sources.auditLogs.unshift({ id: `aud-family-${randomUUID()}`, action, entityType: "familyRecord", entityId: row.id, sessionId: context.incidentId, actorId: actor.id, actorEmail: actor.email, summary, metadata: { ...metadata, requestId: actor.requestId }, createdAt: currentTime() });
  }

  function timeline(context: IncidentContext, actor: FamilyActor, row: Row, title: string, body?: string | null, metadata: Row = {}) {
    sources.timeline.unshift({ id: `tle-family-${randomUUID()}`, sessionId: context.incidentId, caseId: row.caseId ?? null, eventType: "family_relationship", entityType: "familyRecord", entityId: row.id, title, body: body ?? null, metadata, createdById: actor.id, occurredAt: currentTime(), createdAt: currentTime() });
  }

  function updateActor(row: Row, actor: FamilyActor, expectedVersion: number) {
    Object.assign(row, { version: expectedVersion + 1, updatedById: actor.id, updatedBy: actorSnapshot(actor), updatedAt: currentTime() });
  }

  return {
    kind: "memory",

    async list(context, query) {
      const needle = query.search?.toLocaleLowerCase();
      const filtered = sources.families
        .filter((row) => row.sessionId === context.incidentId)
        .map(normalized)
        .filter((row) => !query.verificationStatus || row.verificationStatus === query.verificationStatus)
        .filter((row) => !query.relationship || row.currentClaim.claimedRelationshipType === query.relationship)
        .filter((row) => query.passengerLinked === undefined || Boolean(row.currentClaim.passengerRecordId) === query.passengerLinked)
        .filter((row) => !needle || [row.operationalId, row.firstName, row.lastName, row.phone, row.email, row.passengerFirstName, row.passengerLastName, row.passengerFlight, row.caseId].some((value) => String(value ?? "").toLocaleLowerCase().includes(needle)))
        .sort((left, right) => String(left[query.sortBy] ?? "").localeCompare(String(right[query.sortBy] ?? "")) * (query.sortDirection === "asc" ? 1 : -1));
      return { total: filtered.length, data: filtered.slice(query.offset, query.offset + query.limit) };
    },

    async getById(context, familyId) {
      const row = find(context, familyId);
      return row ? normalized(row) : null;
    },

    async create(context, input, actor) {
      if (!passengerInIncident(context, input.passengerRecordId)) throw new Error("Linked Passenger must belong to the same incident");
      const timestamp = currentTime();
      const row: Row = {
        ...input,
        id: `fam-memory-${randomUUID()}`,
        operationalId: nextOperationalId(sources.families),
        sessionId: context.incidentId,
        normalizedPhone: normalizePhone(input.phone),
        normalizedEmail: normalizeEmail(input.email),
        verificationStatus: "Unverified",
        verificationNotes: null,
        version: 1,
        createdById: actor.id,
        updatedById: actor.id,
        createdBy: actorSnapshot(actor),
        updatedBy: actorSnapshot(actor),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      sources.families.unshift(row);
      const claim = ensureClaim(row);
      Object.assign(claim, { passengerRecordId: input.passengerRecordId ?? null, source: input.source ?? "OPERATOR", claimedById: actor.id });
      audit(context, actor, row, "create_family_record", `Family/NOK record ${row.operationalId} registered`, { relationshipClaimId: claim.id, passengerRecordId: claim.passengerRecordId, claimedRelationship: claim.claimedRelationshipType, potentialDuplicateIds: duplicateIds(row), version: 1 });
      timeline(context, actor, row, `Family/NOK record ${row.operationalId} registered`, undefined, { relationshipClaimId: claim.id, verificationStatus: "Unverified" });
      return normalized(row);
    },

    async update(context, familyId, input, expectedVersion, actor) {
      const row = find(context, familyId);
      if (!row) return { record: null, conflict: false };
      if (Number(row.version ?? 1) !== expectedVersion) return { record: null, conflict: true };
      Object.assign(row, input);
      updateActor(row, actor, expectedVersion);
      audit(context, actor, row, "update_family_record", `Family/NOK record ${row.operationalId} updated`, { changedFields: Object.keys(input), versionBefore: expectedVersion, versionAfter: row.version });
      return { record: normalized(row), conflict: false };
    },

    async correctClaim(context, familyId, input, expectedVersion, expectedClaimVersion, actor) {
      const row = find(context, familyId);
      if (!row) return { record: null, conflict: false };
      const claim = ensureClaim(row);
      if (Number(row.version ?? 1) !== expectedVersion || claim.version !== expectedClaimVersion) return { record: null, conflict: true };
      const { reason, passengerRecordId, ...facts } = input;
      const nextPassengerId = passengerRecordId === undefined ? claim.passengerRecordId : passengerRecordId;
      if (!passengerInIncident(context, nextPassengerId)) throw new Error("Linked Passenger must belong to the same incident");
      const wasTerminal = claim.status !== "PENDING";
      let current = claim;
      if (wasTerminal) {
        Object.assign(claim, { isCurrent: false, status: "SUPERSEDED", supersededAt: currentTime(), version: expectedClaimVersion + 1 });
        current = { ...claim, id: `claim-memory-${randomUUID()}`, isCurrent: true, status: "PENDING", version: 1, passengerRecordId: nextPassengerId, source: "CORRECTION", supersededAt: null, claimedAt: currentTime(), createdAt: currentTime(), updatedAt: currentTime() };
        claims.push(current);
        Object.assign(row, { verificationStatus: "Review required", verificationNotes: reason, verificationDecisionById: null, verificationDecisionAt: null, verifiedRelationship: null });
      } else {
        Object.assign(current, { passengerRecordId: nextPassengerId, version: expectedClaimVersion + 1, updatedAt: currentTime() });
      }
      Object.assign(row, facts, { passengerRecordId: nextPassengerId, normalizedPhone: facts.phone === undefined ? row.normalizedPhone : normalizePhone(facts.phone), normalizedEmail: facts.email === undefined ? row.normalizedEmail : normalizeEmail(facts.email) });
      if (facts.claimedRelationship !== undefined) current.claimedRelationshipType = facts.claimedRelationship;
      if (facts.passengerFirstName !== undefined) current.claimedPassengerFirstName = facts.passengerFirstName;
      if (facts.passengerLastName !== undefined) current.claimedPassengerLastName = facts.passengerLastName;
      if (facts.passengerFlight !== undefined) current.claimedPassengerFlight = facts.passengerFlight;
      updateActor(row, actor, expectedVersion);
      const changedFields = Object.keys(input).filter((key) => key !== "reason");
      audit(context, actor, row, "correct_family_claim", `Claimed facts corrected for ${row.operationalId}`, { changedFields, reason, previousClaimId: claim.id, currentClaimId: current.id, verificationReviewRequired: wasTerminal, passengerRecordId: nextPassengerId, versionBefore: expectedVersion, versionAfter: row.version });
      timeline(context, actor, row, `Relationship claim corrected for ${row.operationalId}`, reason, { changedFields, previousClaimId: claim.id, currentClaimId: current.id, verificationReviewRequired: wasTerminal });
      return { record: normalized(row), conflict: false };
    },

    async decide(context, familyId, input, expectedVersion, expectedClaimVersion, actor) {
      const row = find(context, familyId);
      if (!row) return { record: null, conflict: false };
      const claim = ensureClaim(row);
      if (Number(row.version ?? 1) !== expectedVersion || claim.version !== expectedClaimVersion) return { record: null, conflict: true };
      const previousStatus = claim.status;
      const nextStatus = input.result === "VERIFIED" ? "VERIFIED" : input.result === "REJECTED" ? "REJECTED" : "PENDING";
      claim.status = nextStatus;
      claim.version += 1;
      claim.updatedAt = currentTime();
      const decision = { id: `decision-memory-${randomUUID()}`, incidentId: context.incidentId, relationshipClaimId: claim.id, result: input.result, basis: input.basis, verifiedRelationshipType: input.result === "VERIFIED" ? (input.verifiedRelationshipType ?? claim.claimedRelationshipType) : null, previousStatus, nextStatus, claimVersionBefore: expectedClaimVersion, claimVersionAfter: expectedClaimVersion + 1, decisionById: actor.id, decisionByDisplayName: actor.displayName, decisionAt: currentTime(), requestId: actor.requestId };
      decisions.push(decision);
      Object.assign(row, { verificationStatus: input.result === "VERIFIED" ? "Verified" : input.result === "REJECTED" ? "Rejected" : "Review required", verificationNotes: input.basis, verificationDecisionById: input.result === "REOPENED" ? null : actor.id, verificationDecisionByDisplayName: input.result === "REOPENED" ? null : actor.displayName, verificationDecisionAt: input.result === "REOPENED" ? null : decision.decisionAt, verifiedRelationship: decision.verifiedRelationshipType });
      updateActor(row, actor, expectedVersion);
      const action = input.result === "VERIFIED" ? "verify_family_relationship" : input.result === "REJECTED" ? "reject_family_relationship" : "reopen_family_relationship";
      audit(context, actor, row, action, `Relationship claim for ${row.operationalId} ${input.result.toLocaleLowerCase()}`, { relationshipClaimId: claim.id, decisionId: decision.id, passengerRecordId: claim.passengerRecordId, claimedRelationship: claim.claimedRelationshipType, verifiedRelationship: decision.verifiedRelationshipType, result: input.result, basis: input.basis, before: previousStatus, after: nextStatus, familyVersionBefore: expectedVersion, familyVersionAfter: row.version, claimVersionBefore: expectedClaimVersion, claimVersionAfter: claim.version });
      timeline(context, actor, row, `Relationship ${input.result === "VERIFIED" ? "verified" : input.result === "REJECTED" ? "rejected" : "reopened"}`, input.basis, { relationshipClaimId: claim.id, passengerRecordId: claim.passengerRecordId, result: input.result, version: row.version });
      return { record: normalized(row), conflict: false };
    },

    async importRecords(context, input, actor) {
      const timestamp = currentTime();
      input.records.forEach((item) => {
        const row: Row = { ...item, id: `fam-memory-${randomUUID()}`, operationalId: nextOperationalId(sources.families), sessionId: context.incidentId, sourceBatchId: input.batchId, sourceImportedAt: timestamp, normalizedPhone: normalizePhone(item.phone), normalizedEmail: normalizeEmail(item.email), verificationStatus: "Unverified", version: 1, createdById: actor.id, updatedById: actor.id, createdAt: timestamp, updatedAt: timestamp };
        sources.families.unshift(row);
        const claim = ensureClaim(row);
        Object.assign(claim, { source: "IMPORT", claimedById: actor.id, passengerRecordId: item.passengerRecordId ?? null });
      });
      const status = input.invalidRecords > 0 ? "Imported with errors" : "Imported";
      const batch = sources.importBatches.find((item) => item.id === input.batchId);
      if (batch) Object.assign(batch, { status, updatedAt: timestamp });
      else sources.importBatches.unshift({ id: input.batchId, operationalId: `IMP-${new Date().getFullYear()}-${String(sources.importBatches.length + 1).padStart(6, "0")}`, sessionId: context.incidentId, importType: "family", sourceFilename: input.sourceFilename, status, totalRecords: input.totalRecords, validRecords: input.records.length, invalidRecords: input.invalidRecords, errors: input.errors, createdById: actor.id, createdAt: timestamp });
      audit(context, actor, { id: input.batchId, operationalId: input.batchId }, "import_family_records", `Imported Family/NOK records: ${input.records.length}/${input.totalRecords} valid`, { totalRecords: input.totalRecords, validRecords: input.records.length, invalidRecords: input.invalidRecords });
      timeline(context, actor, { id: input.batchId, operationalId: input.batchId }, `Family/NOK records imported (${input.records.length} records)`, undefined, { totalRecords: input.totalRecords, validRecords: input.records.length });
      return { batchId: input.batchId, status, totalRecords: input.totalRecords, validRecords: input.records.length, invalidRecords: input.invalidRecords };
    }
  };
}

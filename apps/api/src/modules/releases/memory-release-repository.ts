import { randomUUID } from "node:crypto";
import { HttpError } from "../../errors.js";
import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type { ReleaseRepository } from "./release-repository.js";
import type { ReleaseActionRecord, ReleaseActor, ReleaseCandidateRecord, ReleaseCheckRecord, ReleaseCompatibilityRecord, ReleasePrecondition } from "./release-types.js";

type Row = Record<string, any>;
type Sources = { releases: Row[]; matches: Row[]; families: Row[]; passengers: Row[]; auditLogs: Row[]; timeline: Row[]; users?: Row[]; now?: () => string };

function noHold(value?: string | null) {
  return !value || value === "No hold";
}

function commandFingerprint(command: string, actionId: string, values: unknown[]) {
  return JSON.stringify([command, actionId, ...values]);
}

export function createMemoryReleaseRepository(sources: Sources): ReleaseRepository {
  const now = sources.now ?? (() => new Date().toISOString());
  const checks: Row[] = [];
  const operations: Row[] = [];
  let sequence = sources.releases.length + 1;

  for (const row of sources.releases) {
    if (row.incidentId) continue;
    row.incidentId = row.sessionId;
    row.matchingRecordId = row.matchId ?? null;
    row.actionType = String(row.actionType).toUpperCase() === "RELEASE" ? "RELEASE" : "REUNIFICATION";
    row.status = ({ Prepared: "PREPARED", Authorized: "AUTHORIZED", Completed: "COMPLETED", Cancelled: "CANCELLED" } as Row)[row.status] ?? String(row.status ?? "PREPARED").toUpperCase();
    row.version = Number(row.version ?? 1);
    row.preparedAt = row.createdAt ?? now();
    row.legacyImported = true;
    row.verificationEvidenceUnavailable = Boolean(row.identityChecked || row.holdCleared || row.status === "COMPLETED");
    delete row.identityChecked;
    delete row.holdCleared;
  }

  function familyClaim(family: Row) {
    return family.currentClaim ?? {
      id: family.relationshipClaimId ?? `claim-memory-${family.id}`,
      incidentId: family.sessionId,
      familyRecordId: family.id,
      claimedRelationshipType: family.claimedRelationship ?? null,
      status: family.verificationStatus === "Verified" ? "VERIFIED" : family.verificationStatus === "Rejected" ? "REJECTED" : "PENDING",
      isCurrent: true,
      version: Number(family.claimVersion ?? 1)
    };
  }

  function candidate(match: Row): ReleaseCandidateRecord | null {
    const family = sources.families.find((item) => item.id === match.familyRecordId && item.sessionId === match.sessionId);
    const passenger = sources.passengers.find((item) => item.id === match.passengerRecordId && item.sessionId === match.sessionId);
    if (!family || !passenger || !match.matchDecisionId) return null;
    const claim = familyClaim(family);
    const decisionCurrent = match.releaseEligibility?.matchDecision === "CURRENT_CONFIRMED";
    const relationshipVerified = claim.isCurrent && claim.status === "VERIFIED";
    if (!decisionCurrent || !relationshipVerified) return null;
    const blockers = [noHold(passenger.holdStatus) ? null : `Active Passenger hold: ${passenger.holdStatus}`, noHold(match.holdCheck) ? null : `Active Matching hold: ${match.holdCheck}`].filter((item): item is string => Boolean(item));
    return {
      matchDecisionId: match.matchDecisionId,
      matchingRecordId: match.id,
      relationshipClaimId: claim.id,
      passengerRecordId: passenger.id,
      claimVersion: Number(claim.version),
      passengerVersion: Number(passenger.version ?? 1),
      relationshipStatus: claim.status,
      passengerHold: passenger.holdStatus ?? "No hold",
      eligible: blockers.length === 0,
      blockers,
      family: { operationalId: family.operationalId, firstName: family.firstName, lastName: family.lastName, relationshipType: claim.claimedRelationshipType },
      passenger: { operationalId: passenger.operationalId, firstName: passenger.firstName, lastName: passenger.lastName, flightNumber: passenger.flightNumber ?? null, version: Number(passenger.version ?? 1) }
    };
  }

  function precondition(key: ReleasePrecondition["key"], label: string, state: ReleasePrecondition["state"], detail: string): ReleasePrecondition {
    return { key, label, state, detail };
  }

  function view(action: Row): ReleaseActionRecord {
    const match = sources.matches.find((item) => item.id === action.matchingRecordId && item.sessionId === action.incidentId);
    const family = sources.families.find((item) => item.id === match?.familyRecordId && item.sessionId === action.incidentId);
    const passenger = sources.passengers.find((item) => item.id === action.passengerRecordId && item.sessionId === action.incidentId);
    const claim = family ? familyClaim(family) : null;
    const actionChecks = checks.filter((item) => item.releaseActionId === action.id).sort((a, b) => String(b.checkedAt).localeCompare(String(a.checkedAt)));
    const mappedChecks: ReleaseCheckRecord[] = actionChecks.map((item) => ({ ...item, actorDisplayName: sources.users?.find((user) => user.id === item.actorId)?.displayName ?? null, current: Boolean(item.isCurrent && item.claimVersion === claim?.version && item.passengerVersion === Number(passenger?.version ?? 1) && item.relationshipClaimId === action.relationshipClaimId && item.matchDecisionId === action.matchDecisionId) }) as ReleaseCheckRecord);
    const identity = mappedChecks.find((item) => item.type === "IDENTITY" && item.isCurrent);
    const hold = mappedChecks.find((item) => item.type === "HOLD_REVIEW" && item.isCurrent);
    const relationshipCurrent = Boolean(claim && claim.id === action.relationshipClaimId && claim.isCurrent && claim.status === "VERIFIED" && Number(claim.version) === action.relationshipClaimVersion);
    const matchCurrent = Boolean(match && match.matchDecisionId === action.matchDecisionId && match.releaseEligibility?.matchDecision === "CURRENT_CONFIRMED");
    const inputsCurrent = Boolean(relationshipCurrent && matchCurrent && passenger && Number(passenger.version ?? 1) === action.passengerVersion);
    const identityCurrent = Boolean(identity?.current && identity.result === "PASS");
    const passengerHoldClear = Boolean(passenger && noHold(passenger.holdStatus));
    const matchingHoldClear = Boolean(match && noHold(match.holdCheck));
    const holdCurrent = Boolean(hold?.current && hold.result === "PASS" && passengerHoldClear);
    const authorizationCurrent = action.status !== "AUTHORIZED" || (action.authorizedClaimVersion === claim?.version && action.authorizedPassengerVersion === Number(passenger?.version ?? 1));
    const preconditions = [
      precondition("relationship", "Relationship verified", relationshipCurrent ? "PASS" : claim && !claim.isCurrent ? "STALE" : "FAIL", relationshipCurrent ? "Current RelationshipClaim is VERIFIED" : "RelationshipClaim is not current and verified at the prepared version"),
      precondition("match", "Current human match", matchCurrent ? "PASS" : match ? "STALE" : "FAIL", matchCurrent ? "Current human MatchDecision is CONFIRMED" : "MatchDecision is absent, stale, invalidated or superseded"),
      precondition("inputs", "Prepared inputs current", inputsCurrent && authorizationCurrent ? "PASS" : "STALE", inputsCurrent && authorizationCurrent ? `Claim v${claim?.version}; Passenger v${passenger?.version ?? 1}` : "Data used to prepare or authorize this action changed"),
      precondition("identity", "Identity check", identityCurrent ? "PASS" : identity?.current ? "FAIL" : identity ? "STALE" : "FAIL", identityCurrent ? `PASS by ${identity?.actorDisplayName ?? "recorded operator"}` : identity ? "Identity check failed or is no longer current" : "No explicit identity check recorded"),
      precondition("passengerHold", "Passenger hold", passengerHoldClear ? "PASS" : "BLOCKED", passengerHoldClear ? "Passenger hold state allows release" : `Active Passenger hold: ${passenger?.holdStatus ?? "Unknown"}`),
      precondition("matchingHold", "Matching hold", matchingHoldClear ? "PASS" : "BLOCKED", matchingHoldClear ? "Stage 5 matching projection has no active hold" : `Active Matching hold: ${match?.holdCheck ?? "Unknown"}`),
      precondition("holdReview", "Hold review", holdCurrent ? "PASS" : hold?.current ? "FAIL" : hold ? "STALE" : "FAIL", holdCurrent ? `Current hold reviewed by ${hold?.actorDisplayName ?? "recorded operator"}` : hold ? "Hold review failed or is no longer current" : "No explicit hold review recorded")
    ] satisfies ReleasePrecondition[];
    const blockers = preconditions.filter((item) => item.state !== "PASS").map((item) => item.detail);
    return {
      ...action,
      incidentId: action.incidentId,
      actionType: action.actionType,
      status: action.status,
      effectiveState: preconditions.some((item) => item.state === "STALE") ? "REQUIRES_REVIEW" : blockers.length ? "BLOCKED" : "CURRENT",
      preparedByDisplayName: sources.users?.find((item) => item.id === action.preparedById)?.displayName ?? null,
      authorizedByDisplayName: sources.users?.find((item) => item.id === action.authorizedById)?.displayName ?? null,
      completedByDisplayName: sources.users?.find((item) => item.id === action.completedById)?.displayName ?? null,
      passenger: passenger ? { id: passenger.id, operationalId: passenger.operationalId, firstName: passenger.firstName, lastName: passenger.lastName, holdStatus: passenger.holdStatus ?? "No hold", conditionStatus: passenger.conditionStatus ?? "Unknown", version: Number(passenger.version ?? 1) } : null,
      relationship: claim && family ? { id: claim.id, status: claim.status, isCurrent: Boolean(claim.isCurrent), version: Number(claim.version), relationshipType: claim.claimedRelationshipType ?? null, family: { id: family.id, operationalId: family.operationalId, firstName: family.firstName, lastName: family.lastName, caseId: family.caseId ?? null } } : null,
      match: match ? { id: action.matchDecisionId, decision: "CONFIRMED", validity: matchCurrent ? "CURRENT" : "STALE", isCurrent: matchCurrent, decidedAt: match.approvedAt ?? match.updatedAt ?? now() } : null,
      checks: mappedChecks,
      preconditions,
      blockers,
      canAuthorize: action.status === "PREPARED" && blockers.length === 0,
      canComplete: action.status === "AUTHORIZED" && blockers.length === 0 && authorizationCurrent,
      legacyImported: Boolean(action.legacyImported),
      verificationEvidenceUnavailable: Boolean(action.verificationEvidenceUnavailable),
      createdAt: action.createdAt,
      updatedAt: action.updatedAt
    } as ReleaseActionRecord;
  }

  function compatible(record: ReleaseActionRecord): ReleaseCompatibilityRecord {
    const identity = record.checks.some((item) => item.type === "IDENTITY" && item.isCurrent && item.current && item.result === "PASS");
    const hold = record.checks.some((item) => item.type === "HOLD_REVIEW" && item.isCurrent && item.current && item.result === "PASS");
    return { id: record.id, operationalId: record.operationalId, sessionId: record.incidentId, matchId: record.matchingRecordId, passengerRecordId: record.passengerRecordId, familyRecordId: record.relationship?.family.id ?? null, actionType: record.actionType === "RELEASE" ? "Release" : "Reunification", status: ({ PREPARED: "Prepared", AUTHORIZED: "Authorized", COMPLETED: "Completed", CANCELLED: "Cancelled" } as const)[record.status], identityChecked: identity, holdCleared: hold && noHold(record.passenger?.holdStatus), releaseDestination: record.releaseDestination, receivingParty: record.receivingParty, transportMode: record.transportMode, notes: record.completionNotes ?? record.cancelReason ?? record.notes, version: record.version, completedAt: record.completedAt, createdAt: record.createdAt, updatedAt: record.updatedAt };
  }

  function operationRetry(context: IncidentContext, operationId: string, fingerprint: string) {
    const existing = operations.find((item) => item.incidentId === context.incidentId && item.operationId === operationId);
    if (!existing) return null;
    if (existing.commandFingerprint !== fingerprint) throw new HttpError(409, "operationId was already used for a different release command");
    return sources.releases.find((item) => item.id === existing.releaseActionId) ?? null;
  }

  function logOperation(context: IncidentContext, actionId: string, operationId: string, command: string, fingerprint: string, resultVersion: number, actor: ReleaseActor) {
    operations.push({ id: randomUUID(), incidentId: context.incidentId, releaseActionId: actionId, operationId, command, commandFingerprint: fingerprint, resultVersion, requestId: actor.requestId, createdAt: now() });
  }

  function audit(context: IncidentContext, actor: ReleaseActor, action: Row, event: string, summary: string, metadata: Row) {
    sources.auditLogs.unshift({ id: `aud-release-${randomUUID()}`, action: event, entityType: "releaseAction", entityId: action.id, sessionId: context.incidentId, actorId: actor.id, actorEmail: actor.email, summary, metadata: { releaseActionId: action.id, passengerRecordId: action.passengerRecordId, relationshipClaimId: action.relationshipClaimId, matchDecisionId: action.matchDecisionId, requestId: actor.requestId, ...metadata }, createdAt: now() });
  }

  function timeline(context: IncidentContext, actor: ReleaseActor, action: Row, eventType: string, title: string, body: string, metadata: Row) {
    const match = sources.matches.find((item) => item.id === action.matchingRecordId);
    sources.timeline.unshift({ id: `tle-release-${randomUUID()}`, sessionId: context.incidentId, caseId: match?.caseId ?? null, eventType, entityType: "releaseAction", entityId: action.id, title, body, metadata, createdById: actor.id, occurredAt: now(), createdAt: now() });
  }

  function mutation(action: Row | null, idempotent = false) {
    return { record: action ? view(action) : null, conflict: !action, idempotent };
  }

  function findAction(context: IncidentContext, id: string) {
    return sources.releases.find((item) => item.id === id && item.incidentId === context.incidentId) ?? null;
  }

  function recordCheck(context: IncidentContext, id: string, input: any, actor: ReleaseActor, type: "IDENTITY" | "HOLD_REVIEW") {
    const command = type === "IDENTITY" ? "IDENTITY_CHECK" : "HOLD_REVIEW";
    const values = type === "IDENTITY" ? [input.result, input.basis, input.evidenceReference ?? null] : [input.basis];
    const fp = commandFingerprint(command, id, values);
    const retry = operationRetry(context, input.operationId, fp);
    if (retry) return mutation(retry, true);
    const action = findAction(context, id);
    if (!action || action.status !== "PREPARED" || action.version !== input.expectedVersion) return mutation(null);
    const current = view(action);
    if (["relationship", "match", "inputs"].some((key) => current.preconditions.find((item) => item.key === key)?.state !== "PASS")) throw new HttpError(409, "Release inputs changed; cancel and prepare a new action before recording checks");
    const passenger = sources.passengers.find((item) => item.id === action.passengerRecordId);
    const family = sources.families.find((item) => item.id === current.relationship?.family.id);
    const claim = family ? familyClaim(family) : null;
    const previous = checks.find((item) => item.releaseActionId === id && item.type === type && item.isCurrent);
    if (previous) { previous.isCurrent = false; previous.version += 1; }
    const result = type === "IDENTITY" ? input.result : noHold(passenger?.holdStatus) ? "PASS" : "FAIL";
    const check = { id: randomUUID(), incidentId: context.incidentId, releaseActionId: id, type, result, actorId: actor.id, checkedAt: now(), basis: input.basis, evidenceReference: type === "IDENTITY" ? input.evidenceReference ?? null : null, relationshipClaimId: action.relationshipClaimId, claimVersion: claim?.version, matchDecisionId: action.matchDecisionId, passengerVersion: Number(passenger?.version ?? 1), operationId: input.operationId, version: 1, isCurrent: true, supersedesCheckId: previous?.id ?? null, requestId: actor.requestId, createdAt: now() };
    checks.push(check);
    action.version += 1;
    action.updatedAt = now();
    logOperation(context, id, input.operationId, command, fp, action.version, actor);
    audit(context, actor, action, type === "IDENTITY" ? "release_identity_check" : "release_hold_review", `${type === "IDENTITY" ? "Identity" : "Passenger hold"} check ${result}`, { operationId: input.operationId, checkId: check.id, checkType: type, result, basis: input.basis, beforeState: action.status, afterState: action.status });
    timeline(context, actor, action, "release_check", `${type === "IDENTITY" ? "Identity" : "Passenger hold"} check ${result}`, input.basis, { checkType: type, result });
    return mutation(action);
  }

  return {
    kind: "memory",
    async listQueue(context, query) {
      const needle = query.search?.toLocaleLowerCase();
      const all = sources.releases.filter((item) => item.incidentId === context.incidentId).map(view).filter((item) => !query.status || item.status === query.status).filter((item) => !query.actionType || item.actionType === query.actionType).filter((item) => !query.eligibility || (query.eligibility === "eligible" ? item.blockers.length === 0 : item.blockers.length > 0)).filter((item) => !needle || [item.operationalId, item.passenger?.operationalId, item.passenger?.firstName, item.passenger?.lastName, item.relationship?.family.operationalId, item.relationship?.family.firstName, item.relationship?.family.lastName].some((value) => String(value ?? "").toLocaleLowerCase().includes(needle))).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)) * (query.sortDirection === "asc" ? 1 : -1));
      return { total: all.length, data: all.slice(query.offset, query.offset + query.limit) };
    },
    async listCandidates(context, query) {
      const needle = query.search?.toLocaleLowerCase();
      const all = sources.matches.filter((item) => item.sessionId === context.incidentId).map(candidate).filter((item): item is ReleaseCandidateRecord => Boolean(item)).filter((item) => !query.eligibility || (query.eligibility === "eligible" ? item.eligible : !item.eligible)).filter((item) => !needle || [item.family.operationalId, item.family.firstName, item.family.lastName, item.passenger.operationalId, item.passenger.firstName, item.passenger.lastName].some((value) => String(value ?? "").toLocaleLowerCase().includes(needle))).sort((a, b) => a.family.lastName.localeCompare(b.family.lastName) * (query.sortDirection === "asc" ? 1 : -1));
      return { total: all.length, data: all.slice(query.offset, query.offset + query.limit) };
    },
    async getContext(context, id) { const action = findAction(context, id); return action ? view(action) : null; },
    async prepare(context, input, actor) {
      const fp = commandFingerprint("PREPARE", input.matchDecisionId, [input.actionType, input.releaseDestination ?? null, input.receivingParty ?? null, input.transportMode ?? null, input.notes ?? null]);
      const retry = operationRetry(context, input.operationId, fp);
      if (retry) return mutation(retry, true);
      const match = sources.matches.find((item) => item.sessionId === context.incidentId && item.matchDecisionId === input.matchDecisionId);
      const source = match ? candidate(match) : null;
      if (!source) throw new HttpError(409, "Release preparation requires a current VERIFIED RelationshipClaim and current human CONFIRMED MatchDecision");
      if (sources.releases.some((item) => item.incidentId === context.incidentId && item.relationshipClaimId === source.relationshipClaimId && item.matchDecisionId === source.matchDecisionId && item.actionType === input.actionType && ["PREPARED", "AUTHORIZED", "COMPLETED"].includes(item.status))) return mutation(null);
      const action = { id: randomUUID(), operationalId: `REL-${new Date().getFullYear()}-${String(sequence++).padStart(6, "0")}`, incidentId: context.incidentId, actionType: input.actionType, status: "PREPARED", relationshipClaimId: source.relationshipClaimId, matchDecisionId: source.matchDecisionId, matchingRecordId: source.matchingRecordId, passengerRecordId: source.passengerRecordId, relationshipClaimVersion: source.claimVersion, passengerVersion: source.passengerVersion, releaseDestination: input.releaseDestination ?? null, receivingParty: input.receivingParty ?? null, transportMode: input.transportMode ?? null, notes: input.notes ?? null, version: 1, preparedById: actor.id, preparedAt: now(), legacyImported: false, verificationEvidenceUnavailable: false, createdAt: now(), updatedAt: now() };
      sources.releases.unshift(action);
      logOperation(context, action.id, input.operationId, "PREPARE", fp, 1, actor);
      audit(context, actor, action, "prepare_release", `${input.actionType} ${action.operationalId} prepared`, { operationId: input.operationId, claimVersion: source.claimVersion, passengerVersion: source.passengerVersion, beforeState: null, afterState: "PREPARED" });
      timeline(context, actor, action, "release", `${input.actionType} ${action.operationalId} prepared`, input.notes ?? "Release action prepared for independent checks", { status: "PREPARED" });
      return mutation(action);
    },
    async recordIdentityCheck(context, id, input, actor) { return recordCheck(context, id, input, actor, "IDENTITY"); },
    async recordHoldReview(context, id, input, actor) { return recordCheck(context, id, input, actor, "HOLD_REVIEW"); },
    async authorize(context, id, input, actor) {
      const fp = commandFingerprint("AUTHORIZE", id, [input.reason]);
      const retry = operationRetry(context, input.operationId, fp);
      if (retry) return mutation(retry, true);
      const action = findAction(context, id);
      if (!action || action.status !== "PREPARED" || action.version !== input.expectedVersion) return mutation(null);
      const current = view(action);
      if (!current.canAuthorize) throw new HttpError(409, `Release authorization blocked: ${current.blockers.join("; ")}`);
      action.status = "AUTHORIZED"; action.authorizedById = actor.id; action.authorizedAt = now(); action.authorizationReason = input.reason; action.authorizedClaimVersion = current.relationship?.version; action.authorizedPassengerVersion = current.passenger?.version; action.version += 1; action.updatedAt = now();
      logOperation(context, id, input.operationId, "AUTHORIZE", fp, action.version, actor);
      audit(context, actor, action, "authorize_release", `${action.actionType} ${action.operationalId} authorized`, { operationId: input.operationId, reason: input.reason, beforeState: "PREPARED", afterState: "AUTHORIZED" });
      timeline(context, actor, action, "release", `${action.actionType} ${action.operationalId} authorized`, input.reason, { status: "AUTHORIZED" });
      return mutation(action);
    },
    async complete(context, id, input, actor) {
      const fp = commandFingerprint("COMPLETE", id, [input.reason]);
      const retry = operationRetry(context, input.operationId, fp);
      if (retry) return mutation(retry, true);
      const action = findAction(context, id);
      if (!action || action.status !== "AUTHORIZED" || action.version !== input.expectedVersion) return mutation(null);
      const current = view(action);
      if (!current.canComplete) throw new HttpError(409, `Release completion blocked: ${current.blockers.join("; ")}`);
      if (action.actionType === "RELEASE" && !action.receivingParty) throw new HttpError(400, "Receiving party is required to complete RELEASE");
      action.status = "COMPLETED"; action.completedById = actor.id; action.completedAt = now(); action.completionNotes = input.reason; action.version += 1; action.updatedAt = now();
      logOperation(context, id, input.operationId, "COMPLETE", fp, action.version, actor);
      audit(context, actor, action, "complete_release", `${action.actionType} ${action.operationalId} completed`, { operationId: input.operationId, reason: input.reason, beforeState: "AUTHORIZED", afterState: "COMPLETED" });
      timeline(context, actor, action, action.actionType === "RELEASE" ? "release" : "reunification", `${action.actionType} ${action.operationalId} completed`, input.reason, { status: "COMPLETED" });
      return mutation(action);
    },
    async cancel(context, id, input, actor) {
      const fp = commandFingerprint("CANCEL", id, [input.reason]);
      const retry = operationRetry(context, input.operationId, fp);
      if (retry) return mutation(retry, true);
      const action = findAction(context, id);
      if (!action || !["PREPARED", "AUTHORIZED"].includes(action.status) || action.version !== input.expectedVersion) return mutation(null);
      const before = action.status;
      action.status = "CANCELLED"; action.cancelledById = actor.id; action.cancelledAt = now(); action.cancelReason = input.reason; action.version += 1; action.updatedAt = now();
      logOperation(context, id, input.operationId, "CANCEL", fp, action.version, actor);
      audit(context, actor, action, "cancel_release", `${action.actionType} ${action.operationalId} cancelled`, { operationId: input.operationId, reason: input.reason, beforeState: before, afterState: "CANCELLED" });
      timeline(context, actor, action, "release", `${action.actionType} ${action.operationalId} cancelled`, input.reason, { status: "CANCELLED" });
      return mutation(action);
    },
    async listCompatibility(context, query) {
      const result = await this.listQueue(context, query);
      return { total: result.total, data: result.data.map(compatible) };
    }
  };
}

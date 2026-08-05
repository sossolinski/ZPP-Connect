import { randomUUID } from "node:crypto";
import { HttpError } from "../../errors.js";
import type { IncidentContext } from "../incident-access/incident-access-types.js";
import type { MatchingRepository } from "./matching-repository.js";
import type { MatchDecisionRecord, MatchingActor, MatchingClaimProjection, MatchingCompatibilityRecord, MatchingContextRecord, MatchingPassengerProjection, MatchingQueueItem, MatchSignal, MatchSuggestionRecord } from "./matching-types.js";

type Row = Record<string, any>;
type Sources = { matches: Row[]; families: Row[]; passengers: Row[]; auditLogs: Row[]; timeline: Row[]; users?: Row[]; now?: () => string };
const algorithm = "zpp-deterministic-candidate";
const algorithmVersion = "1.0.0";

function same(left?: string | null, right?: string | null) {
  return Boolean(left?.trim() && right?.trim() && left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase());
}

export function createMemoryMatchingRepository(sources: Sources): MatchingRepository {
  const now = sources.now ?? (() => new Date().toISOString());
  const suggestions: Row[] = [];
  const decisions: Row[] = [];

  function familyClaim(row: Row) {
    const current = row.currentClaim;
    return current ?? {
      id: `claim-memory-${row.id}`,
      incidentId: row.sessionId,
      familyRecordId: row.id,
      passengerRecordId: row.passengerRecordId ?? null,
      claimedRelationshipType: row.claimedRelationship ?? null,
      claimedPassengerFirstName: row.passengerFirstName ?? null,
      claimedPassengerLastName: row.passengerLastName ?? null,
      claimedPassengerFlight: row.passengerFlight ?? null,
      status: row.verificationStatus === "Verified" ? "VERIFIED" : row.verificationStatus === "Rejected" ? "REJECTED" : "PENDING",
      isCurrent: true,
      version: Number(row.claimVersion ?? 1),
      updatedAt: row.updatedAt ?? now()
    };
  }

  function findClaim(context: IncidentContext, claimId: string) {
    for (const family of sources.families.filter((item) => item.sessionId === context.incidentId)) {
      const claim = familyClaim(family);
      if (claim.id === claimId && claim.isCurrent) return { claim, family };
    }
    return null;
  }

  function pax(row: Row): MatchingPassengerProjection {
    return { id: row.id, operationalId: row.operationalId, firstName: row.firstName, lastName: row.lastName, dateOfBirth: row.dateOfBirth ?? null, flightNumber: row.flightNumber ?? null, route: row.route ?? null, seat: row.seat ?? null, conditionStatus: row.conditionStatus ?? "Unknown", holdStatus: row.holdStatus ?? "No hold", version: Number(row.version ?? 1) };
  }

  function mappedSuggestion(row: Row): MatchSuggestionRecord {
    return { ...row, passenger: sources.passengers.find((item) => item.id === row.passengerRecordId) ? pax(sources.passengers.find((item) => item.id === row.passengerRecordId)!) : undefined } as MatchSuggestionRecord;
  }

  function mappedDecision(row: Row, claimVersion: number): MatchDecisionRecord {
    const passenger = sources.passengers.find((item) => item.id === row.passengerRecordId);
    const effectiveValidity = row.validity === "CURRENT" && row.isCurrent && (row.claimVersion !== claimVersion || row.passengerVersion !== Number(passenger?.version ?? 1)) ? "STALE" : row.validity;
    return { ...row, effectiveValidity, decisionByDisplayName: sources.users?.find((item) => item.id === row.decisionById)?.displayName ?? null } as MatchDecisionRecord;
  }

  function claimProjection(pair: { claim: Row; family: Row }): MatchingClaimProjection {
    return { id: pair.claim.id, incidentId: pair.claim.incidentId, familyRecordId: pair.claim.familyRecordId, passengerRecordId: pair.claim.passengerRecordId ?? null, claimedRelationshipType: pair.claim.claimedRelationshipType ?? null, claimedPassengerFirstName: pair.claim.claimedPassengerFirstName ?? null, claimedPassengerLastName: pair.claim.claimedPassengerLastName ?? null, claimedPassengerFlight: pair.claim.claimedPassengerFlight ?? null, status: pair.claim.status, isCurrent: Boolean(pair.claim.isCurrent), version: Number(pair.claim.version), updatedAt: pair.claim.updatedAt, family: { id: pair.family.id, operationalId: pair.family.operationalId, firstName: pair.family.firstName, lastName: pair.family.lastName, verificationStatus: pair.family.verificationStatus, verifiedRelationship: pair.family.verifiedRelationship ?? null } };
  }

  function item(context: IncidentContext, claimId: string): MatchingQueueItem | null {
    const pair = findClaim(context, claimId);
    if (!pair) return null;
    const activeSuggestions = suggestions.filter((row) => row.incidentId === context.incidentId && row.relationshipClaimId === claimId && row.isCurrent && ["ACTIVE", "USED"].includes(row.status)).sort((a, b) => b.score - a.score);
    const acceptedRow = decisions.find((row) => row.incidentId === context.incidentId && row.relationshipClaimId === claimId && row.decision === "CONFIRMED" && row.isCurrent);
    const accepted = acceptedRow ? mappedDecision(acceptedRow, pair.claim.version) : null;
    const state = accepted ? (accepted.effectiveValidity === "CURRENT" ? "CONFIRMED" : "STALE") : activeSuggestions.length ? "SUGGESTED" : "UNMATCHED";
    return { relationshipClaim: claimProjection(pair), state, suggestionCount: activeSuggestions.length, topSuggestion: activeSuggestions[0] ? mappedSuggestion(activeSuggestions[0]) : null, currentDecision: accepted, updatedAt: accepted?.decidedAt ?? activeSuggestions[0]?.generatedAt ?? pair.claim.updatedAt };
  }

  function full(context: IncidentContext, claimId: string): MatchingContextRecord | null {
    const base = item(context, claimId);
    if (!base) return null;
    return { ...base, suggestions: suggestions.filter((row) => row.incidentId === context.incidentId && row.relationshipClaimId === claimId).sort((a, b) => b.score - a.score).map(mappedSuggestion), decisionHistory: decisions.filter((row) => row.incidentId === context.incidentId && row.relationshipClaimId === claimId).sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt))).map((row) => mappedDecision(row, base.relationshipClaim.version)) };
  }

  function explain(claim: Row, family: Row, candidate: Row) {
    const checks = [
      { key: "linked-passenger", label: "Passenger explicitly linked in the current claim", available: Boolean(claim.passengerRecordId), matches: claim.passengerRecordId === candidate.id },
      { key: "last-name", label: "Passenger surname matches the claim", available: Boolean(claim.claimedPassengerLastName), matches: same(claim.claimedPassengerLastName, candidate.lastName) },
      { key: "first-name", label: "Passenger first name matches the claim", available: Boolean(claim.claimedPassengerFirstName), matches: same(claim.claimedPassengerFirstName, candidate.firstName) },
      { key: "flight", label: "Flight matches the claim", available: Boolean(claim.claimedPassengerFlight), matches: same(claim.claimedPassengerFlight, candidate.flightNumber) },
      { key: "case", label: "Operational case aligns", available: Boolean(family.caseId && candidate.caseId), matches: same(family.caseId, candidate.caseId) }
    ].filter((check) => check.available);
    const positiveSignals = checks.filter((check) => check.matches).map(({ key, label }) => ({ key, label })) as MatchSignal[];
    const conflicts = checks.filter((check) => !check.matches).map(({ key, label }) => ({ key, label: label.replace("matches", "differs from") })) as MatchSignal[];
    const score = checks.length ? Number((positiveSignals.length / checks.length).toFixed(4)) : 0;
    const eligible = claim.passengerRecordId === candidate.id || (same(claim.claimedPassengerLastName, candidate.lastName) && (same(claim.claimedPassengerFirstName, candidate.firstName) || same(claim.claimedPassengerFlight, candidate.flightNumber)));
    return { positiveSignals, conflicts, score, eligible };
  }

  function command(action: string, claimId: string, passengerId: string, suggestionId?: string | null) {
    return [action, claimId, passengerId, suggestionId ?? "manual"].join(":");
  }

  function idempotent(context: IncidentContext, operationId: string, fingerprint: string) {
    const existing = decisions.find((row) => row.incidentId === context.incidentId && row.operationId === operationId);
    if (!existing) return false;
    if (existing.commandFingerprint !== fingerprint) throw new HttpError(409, "operationId was already used for a different matching command");
    return true;
  }

  function audit(context: IncidentContext, actor: MatchingActor, action: string, entityId: string, summary: string, metadata: Row) {
    sources.auditLogs.unshift({ id: `aud-match-${randomUUID()}`, action, entityType: "matchDecision", entityId, sessionId: context.incidentId, actorId: actor.id, actorEmail: actor.email, summary, metadata: { ...metadata, requestId: actor.requestId }, createdAt: now() });
  }

  function timeline(context: IncidentContext, actor: MatchingActor, family: Row, entityId: string, title: string, body: string, metadata: Row) {
    sources.timeline.unshift({ id: `tle-match-${randomUUID()}`, sessionId: context.incidentId, caseId: family.caseId ?? null, eventType: "matching", entityType: "matchDecision", entityId, title, body, metadata, createdById: actor.id, occurredAt: now(), createdAt: now() });
  }

  function compatibility(row: Row): MatchingCompatibilityRecord | null {
    const family = sources.families.find((item) => item.id === row.familyRecordId && item.sessionId === row.sessionId);
    const passenger = sources.passengers.find((item) => item.id === row.passengerRecordId && item.sessionId === row.sessionId);
    if (!family || !passenger) return null;
    const claim = familyClaim(family);
    const accepted = decisions.find((item) => item.matchingRecordId === row.id && item.decision === "CONFIRMED" && item.isCurrent);
    const current = Boolean(accepted && claim.isCurrent && accepted.claimVersion === claim.version && accepted.passengerVersion === Number(passenger.version ?? 1) && accepted.validity === "CURRENT");
    const stale = Boolean(accepted && !current);
    const relationshipVerified = claim.status === "VERIFIED";
    const blockers = [relationshipVerified ? null : "Relationship claim is not verified", current ? null : stale ? "Match decision is stale" : "No current confirmed match", passenger.holdStatus && passenger.holdStatus !== "No hold" ? `Passenger hold: ${passenger.holdStatus}` : null, row.holdCheck && row.holdCheck !== "No hold" ? `Matching hold: ${row.holdCheck}` : null].filter((value): value is string => Boolean(value));
    const source = suggestions.find((item) => item.id === row.suggestionId);
    return { ...row, relationshipClaimId: claim.id, matchDecisionId: accepted?.id ?? null, status: current ? "Verified match" : stale ? "Requires review" : row.status, matchScore: source?.score ?? null, verificationChecklist: source ? { algorithm: source.algorithm, algorithmVersion: source.algorithmVersion, positiveSignals: source.positiveSignals, conflicts: source.conflicts } : { source: "manual" }, decisionNotes: accepted?.reason ?? row.decisionNotes, approvedById: accepted?.decisionById ?? null, approvedAt: accepted?.decidedAt ?? null, version: Number(row.version ?? 1), releaseEligibility: { relationshipVerification: relationshipVerified ? "VERIFIED" : "NOT_VERIFIED", matchDecision: current ? "CURRENT_CONFIRMED" : stale ? "STALE" : "NOT_CONFIRMED", passengerHold: passenger.holdStatus ?? "Unknown", passengerCondition: passenger.conditionStatus ?? "Unknown", eligible: blockers.length === 0, blockers } } as MatchingCompatibilityRecord;
  }

  for (const row of sources.matches) {
    row.version = Number(row.version ?? 1);
    const family = sources.families.find((item) => item.id === row.familyRecordId);
    const passenger = sources.passengers.find((item) => item.id === row.passengerRecordId);
    if (!family || !passenger) continue;
    const claim = familyClaim(family);
    row.relationshipClaimId = claim.id;
    if (row.matchScore !== undefined && row.matchScore !== null) {
      const suggestionId = `suggestion-memory-${row.id}`;
      row.suggestionId = suggestionId;
      suggestions.push({ id: suggestionId, incidentId: row.sessionId, relationshipClaimId: claim.id, passengerRecordId: passenger.id, score: Number(row.matchScore), positiveSignals: [], conflicts: [], algorithm: "legacy-matching-record", algorithmVersion: "legacy-v1", generationId: randomUUID(), claimVersion: claim.version, passengerVersion: Number(passenger.version ?? 1), status: "ACTIVE", isCurrent: true, version: 1, generatedAt: row.createdAt ?? now(), createdAt: row.createdAt ?? now(), updatedAt: row.updatedAt ?? now() });
    }
    if (["Verified match", "Reunited", "Released"].includes(String(row.status))) {
      const legacyDecision = { id: `decision-memory-${row.id}`, incidentId: row.sessionId, relationshipClaimId: claim.id, passengerRecordId: passenger.id, matchingRecordId: row.id, suggestionId: row.suggestionId ?? null, decision: "CONFIRMED", reason: row.decisionNotes ?? row.matchBasis ?? "Historical matching decision", validity: "CURRENT", isCurrent: true, claimVersion: claim.version, passengerVersion: Number(passenger.version ?? 1), operationId: randomUUID(), commandFingerprint: `legacy:${row.id}`, decisionById: row.approvedById ?? null, decidedAt: row.approvedAt ?? row.updatedAt ?? now(), requestId: null, createdAt: row.createdAt ?? now() };
      decisions.push(legacyDecision);
      row.matchDecisionId = legacyDecision.id;
    }
    Object.assign(row, compatibility(row) ?? {});
  }

  return {
    kind: "memory",
    async listQueue(context, query) {
      const needle = query.search?.toLocaleLowerCase();
      const all = sources.families.filter((family) => family.sessionId === context.incidentId).map((family) => item(context, familyClaim(family).id)).filter((value): value is MatchingQueueItem => Boolean(value)).filter((value) => !query.relationshipStatus || value.relationshipClaim.status === query.relationshipStatus).filter((value) => !query.state || value.state === query.state).filter((value) => !needle || [value.relationshipClaim.family.operationalId, value.relationshipClaim.family.firstName, value.relationshipClaim.family.lastName, value.relationshipClaim.claimedPassengerFirstName, value.relationshipClaim.claimedPassengerLastName, value.relationshipClaim.claimedPassengerFlight].some((entry) => String(entry ?? "").toLocaleLowerCase().includes(needle)));
      all.sort((a, b) => String(query.sortBy === "claimant" ? a.relationshipClaim.family.lastName : query.sortBy === "state" ? a.state : a.updatedAt).localeCompare(String(query.sortBy === "claimant" ? b.relationshipClaim.family.lastName : query.sortBy === "state" ? b.state : b.updatedAt)) * (query.sortDirection === "asc" ? 1 : -1));
      return { total: all.length, data: all.slice(query.offset, query.offset + query.limit) };
    },
    async getContext(context, claimId) { return full(context, claimId); },
    async listSuggestions(context, claimId, query) {
      const all = suggestions.filter((row) => row.incidentId === context.incidentId && row.relationshipClaimId === claimId && (!query.status || row.status === query.status) && (query.hasConflicts === undefined || (Array.isArray(row.conflicts) && row.conflicts.length > 0) === query.hasConflicts)).sort((a, b) => (a.score - b.score) * (query.sortDirection === "asc" ? 1 : -1));
      return { total: all.length, data: all.slice(query.offset, query.offset + query.limit).map(mappedSuggestion) };
    },
    async generateSuggestions(context, claimId, input, actor) {
      const pair = findClaim(context, claimId);
      if (!pair) throw new HttpError(404, "Current relationship claim not found");
      if (pair.claim.version !== input.expectedClaimVersion) throw new HttpError(409, "Relationship claim changed before suggestions were generated");
      suggestions.filter((row) => row.incidentId === context.incidentId && row.relationshipClaimId === claimId && row.isCurrent).forEach((row) => Object.assign(row, { isCurrent: false, status: "OBSOLETE", version: row.version + 1 }));
      const narrowed = sources.passengers.filter((candidate) => candidate.sessionId === context.incidentId && (candidate.id === pair.claim.passengerRecordId || same(candidate.lastName, pair.claim.claimedPassengerLastName) || same(candidate.flightNumber, pair.claim.claimedPassengerFlight) || same(candidate.caseId, pair.family.caseId))).slice(0, 200);
      const generationId = randomUUID();
      narrowed.map((candidate) => ({ candidate, result: explain(pair.claim, pair.family, candidate) })).filter(({ result }) => result.eligible).sort((a, b) => b.result.score - a.result.score).slice(0, 100).forEach(({ candidate, result }) => suggestions.push({ id: `suggestion-memory-${randomUUID()}`, incidentId: context.incidentId, relationshipClaimId: claimId, passengerRecordId: candidate.id, score: result.score, positiveSignals: result.positiveSignals, conflicts: result.conflicts, algorithm, algorithmVersion, generationId, claimVersion: pair.claim.version, passengerVersion: Number(candidate.version ?? 1), status: "ACTIVE", isCurrent: true, version: 1, generatedAt: now(), createdAt: now(), updatedAt: now() }));
      audit(context, actor, "generate_match_suggestions", claimId, `Generated matching suggestions`, { relationshipClaimId: claimId, generationId, algorithm, algorithmVersion, candidatePoolSize: narrowed.length, suggestionCount: suggestions.filter((row) => row.generationId === generationId).length, claimVersion: pair.claim.version });
      return this.listSuggestions(context, claimId, { limit: 200, offset: 0, sortDirection: "desc", status: "ACTIVE" });
    },
    async listCandidates(context, claimId, query) {
      if (!findClaim(context, claimId)) return { total: 0, data: [] };
      const needle = query.search?.toLocaleLowerCase();
      const all = sources.passengers.filter((row) => row.sessionId === context.incidentId).filter((row) => !needle || [row.operationalId, row.firstName, row.lastName, row.flightNumber, row.route, row.seat, row.pnr, row.ticketNumber].some((value) => String(value ?? "").toLocaleLowerCase().includes(needle))).sort((a, b) => String(a.lastName).localeCompare(String(b.lastName)) * (query.sortDirection === "asc" ? 1 : -1));
      return { total: all.length, data: all.slice(query.offset, query.offset + query.limit).map(pax) };
    },
    async confirm(context, claimId, input, actor) {
      const commandFingerprint = command("CONFIRMED", claimId, input.passengerRecordId, input.suggestionId);
      if (idempotent(context, input.operationId, commandFingerprint)) return { record: full(context, claimId), conflict: false, idempotent: true };
      const pair = findClaim(context, claimId);
      const passenger = sources.passengers.find((row) => row.id === input.passengerRecordId && row.sessionId === context.incidentId);
      if (!pair || !passenger) return { record: null, conflict: true };
      if (pair.claim.version !== input.expectedClaimVersion || Number(passenger.version ?? 1) !== input.expectedPassengerVersion) return { record: null, conflict: true };
      const previous = decisions.find((row) => row.incidentId === context.incidentId && row.relationshipClaimId === claimId && row.decision === "CONFIRMED" && row.isCurrent);
      const previousPassenger = sources.passengers.find((row) => row.id === previous?.passengerRecordId && row.sessionId === context.incidentId);
      if (previous && previousPassenger && previous.claimVersion === pair.claim.version && previous.passengerVersion === Number(previousPassenger.version ?? 1)) return { record: null, conflict: true };
      const source = input.suggestionId ? suggestions.find((row) => row.id === input.suggestionId && row.relationshipClaimId === claimId && row.passengerRecordId === passenger.id && row.isCurrent && row.status === "ACTIVE") : null;
      if (input.suggestionId && !source) return { record: null, conflict: true };
      const match: Row = { id: `match-memory-${randomUUID()}`, operationalId: `MAT-${new Date().getFullYear()}-${String(sources.matches.length + 1).padStart(6, "0")}`, sessionId: context.incidentId, caseId: pair.family.caseId ?? passenger.caseId ?? null, familyRecordId: pair.family.id, passengerRecordId: passenger.id, relationshipClaimId: claimId, suggestionId: source?.id ?? null, status: "Verified match", matchScore: source?.score ?? null, matchBasis: source ? `Suggestion ${source.algorithm}/${source.algorithmVersion} reviewed by a human` : "Manual Passenger match confirmed by a human", holdCheck: "No hold", decisionNotes: input.reason, approvedById: actor.id, approvedAt: now(), version: 1, createdById: actor.id, updatedById: actor.id, createdAt: now(), updatedAt: now() };
      sources.matches.unshift(match);
      if (previous) Object.assign(previous, { isCurrent: false, validity: "SUPERSEDED" });
      const created: Row = { id: `decision-memory-${randomUUID()}`, incidentId: context.incidentId, relationshipClaimId: claimId, passengerRecordId: passenger.id, matchingRecordId: match.id, suggestionId: source?.id ?? null, decision: "CONFIRMED", reason: input.reason, validity: "CURRENT", isCurrent: true, claimVersion: pair.claim.version, passengerVersion: Number(passenger.version ?? 1), operationId: input.operationId, commandFingerprint, decisionById: actor.id, decidedAt: now(), requestId: actor.requestId, supersedesDecisionId: previous?.id ?? null, createdAt: now() };
      decisions.push(created);
      match.matchDecisionId = created.id;
      Object.assign(match, compatibility(match) ?? {});
      if (source) Object.assign(source, { status: "USED", version: source.version + 1 });
      const common = { relationshipClaimId: claimId, passengerRecordId: passenger.id, suggestionId: source?.id ?? null, decisionId: created.id, result: "CONFIRMED", reason: input.reason, algorithm: source?.algorithm, algorithmVersion: source?.algorithmVersion, score: source?.score, claimVersion: pair.claim.version, passengerVersion: Number(passenger.version ?? 1), operationId: input.operationId };
      audit(context, actor, source ? "confirm_suggested_match" : "confirm_manual_match", created.id, `Passenger match confirmed for ${pair.family.operationalId}`, common);
      timeline(context, actor, pair.family, created.id, source ? "Suggested Passenger match confirmed" : "Manual Passenger match confirmed", input.reason, common);
      return { record: full(context, claimId), conflict: false };
    },
    async reject(context, claimId, input, actor) {
      const commandFingerprint = command("REJECTED", claimId, input.passengerRecordId, input.suggestionId);
      if (idempotent(context, input.operationId, commandFingerprint)) return { record: full(context, claimId), conflict: false, idempotent: true };
      const pair = findClaim(context, claimId);
      const passenger = sources.passengers.find((row) => row.id === input.passengerRecordId && row.sessionId === context.incidentId);
      const source = suggestions.find((row) => row.id === input.suggestionId && row.incidentId === context.incidentId && row.relationshipClaimId === claimId && row.passengerRecordId === input.passengerRecordId && row.isCurrent && row.status === "ACTIVE" && row.version === input.expectedSuggestionVersion);
      if (!pair || !passenger || !source || pair.claim.version !== input.expectedClaimVersion || Number(passenger.version ?? 1) !== input.expectedPassengerVersion) return { record: null, conflict: true };
      Object.assign(source, { status: "REJECTED", isCurrent: false, version: source.version + 1 });
      const created = { id: `decision-memory-${randomUUID()}`, incidentId: context.incidentId, relationshipClaimId: claimId, passengerRecordId: passenger.id, suggestionId: source.id, decision: "REJECTED", reason: input.reason, validity: "HISTORICAL", isCurrent: false, claimVersion: pair.claim.version, passengerVersion: Number(passenger.version ?? 1), operationId: input.operationId, commandFingerprint, decisionById: actor.id, decidedAt: now(), requestId: actor.requestId, createdAt: now() };
      decisions.push(created);
      audit(context, actor, "reject_match_suggestion", created.id, `Matching suggestion rejected for ${pair.family.operationalId}`, { relationshipClaimId: claimId, passengerRecordId: passenger.id, suggestionId: source.id, decisionId: created.id, result: "REJECTED", reason: input.reason, operationId: input.operationId });
      return { record: full(context, claimId), conflict: false };
    },
    async invalidate(context, claimId, input, actor) {
      const pair = findClaim(context, claimId);
      const target = decisions.find((row) => row.id === input.decisionId && row.incidentId === context.incidentId && row.relationshipClaimId === claimId && row.decision === "CONFIRMED");
      const commandFingerprint = command("INVALIDATED", claimId, target?.passengerRecordId ?? "missing", input.decisionId);
      if (idempotent(context, input.operationId, commandFingerprint)) return { record: full(context, claimId), conflict: false, idempotent: true };
      const existing = target?.isCurrent ? target : undefined;
      const passenger = sources.passengers.find((row) => row.id === existing?.passengerRecordId && row.sessionId === context.incidentId);
      if (!pair || !existing || !passenger || pair.claim.version !== input.expectedClaimVersion || Number(passenger.version ?? 1) !== input.expectedPassengerVersion) return { record: null, conflict: true };
      Object.assign(existing, { isCurrent: false, validity: "SUPERSEDED" });
      const match = sources.matches.find((row) => row.id === existing.matchingRecordId);
      if (match) {
        Object.assign(match, { status: "Potential match", matchDecisionId: null, decisionNotes: input.reason, approvedById: null, approvedAt: null, version: Number(match.version ?? 1) + 1, updatedById: actor.id, updatedAt: now() });
        Object.assign(match, compatibility(match) ?? {});
      }
      const created = { id: `decision-memory-${randomUUID()}`, incidentId: context.incidentId, relationshipClaimId: claimId, passengerRecordId: passenger.id, matchingRecordId: existing.matchingRecordId, suggestionId: existing.suggestionId, decision: "INVALIDATED", reason: input.reason, validity: "HISTORICAL", isCurrent: false, claimVersion: pair.claim.version, passengerVersion: Number(passenger.version ?? 1), operationId: input.operationId, commandFingerprint, decisionById: actor.id, decidedAt: now(), requestId: actor.requestId, supersedesDecisionId: existing.id, createdAt: now() };
      decisions.push(created);
      audit(context, actor, "invalidate_match_decision", created.id, `Passenger match invalidated for ${pair.family.operationalId}`, { relationshipClaimId: claimId, passengerRecordId: passenger.id, previousDecisionId: existing.id, decisionId: created.id, result: "INVALIDATED", reason: input.reason, operationId: input.operationId });
      timeline(context, actor, pair.family, created.id, "Passenger match invalidated", input.reason, { relationshipClaimId: claimId, passengerRecordId: passenger.id, decisionId: created.id });
      return { record: full(context, claimId), conflict: false };
    },
    async setHold(context, matchingRecordId, input, actor) {
      const row = sources.matches.find((item) => item.id === matchingRecordId && item.sessionId === context.incidentId);
      if (!row) return { record: null, conflict: false };
      if (Number(row.version ?? 1) !== input.expectedVersion) return { record: null, conflict: true };
      Object.assign(row, { holdCheck: input.holdCheck, decisionNotes: input.reason, version: input.expectedVersion + 1, updatedById: actor.id, updatedAt: now() });
      audit(context, actor, input.holdCheck === "No hold" ? "clear_matching_hold" : "place_matching_hold", row.id, input.holdCheck === "No hold" ? "Matching hold cleared" : "Matching hold applied", { matchingRecordId: row.id, holdCheck: input.holdCheck, reason: input.reason, versionBefore: input.expectedVersion, versionAfter: row.version });
      return { record: compatibility(row), conflict: false };
    },
    async listCompatibility(context, query) {
      const needle = query.search?.toLocaleLowerCase();
      const all = sources.matches.filter((row) => row.sessionId === context.incidentId).map(compatibility).filter((row): row is MatchingCompatibilityRecord => Boolean(row)).filter((row) => !query.status || row.status === query.status).filter((row) => !needle || [row.operationalId, row.caseId].some((value) => String(value ?? "").toLocaleLowerCase().includes(needle))).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)) * (query.sortDirection === "asc" ? 1 : -1));
      return { total: all.length, data: all.slice(query.offset, query.offset + query.limit) };
    },
    async getReleaseCompatibility(context, matchingRecordId) {
      const row = sources.matches.find((item) => item.id === matchingRecordId && item.sessionId === context.incidentId);
      return row ? compatibility(row) : null;
    }
  };
}

import type { PrismaClient, Prisma } from "@prisma/client";
import type { JourneyEntity, JourneyRecord, JourneySection, JourneyStep, SupportJourney, DashboardAvailability } from "@zpp/shared";
import { workflowStates } from "@zpp/shared";
import { HttpError } from "../../errors.js";
import type { IncidentContext } from "../incident-access/incident-access-types.js";
import { EffectiveAccessService } from "../identity/effective-access-service.js";
import { createPrismaMatchingRepository } from "../matching/prisma-matching-repository.js";
import { createPrismaReleaseRepository } from "../releases/prisma-release-repository.js";
import { suitableRequestOwnerIds } from "../requests/request-owner-policy.js";
import { operationalActivityText } from "../workspace/incident-workspace-reader.js";

export const journeyReadPermission = { enquiry: "enquiry:read", family: "family:read", passenger: "passenger:read", claim: "matching:read", release: "release:read" } as const;
const limit = 6;
const unavailable = { status: "unavailable" } as const;
const name = (row: {firstName: string; lastName: string}) => `${row.firstName} ${row.lastName}`;
const fact = (label: string, value: string | null | undefined) => ({ label, value: value || "Not recorded" });
const href = (path: string, key: string, id: string) => `${path}?${key}=${encodeURIComponent(id)}`;
const section = (items: JourneyRecord[], total = items.length): DashboardAvailability<JourneySection> => ({ status: "available", value: { items, total, limit } });

/** Traversal discovers IDs; only individually permitted source projections leave this reader. */
export async function readSupportJourney(db: PrismaClient, context: IncidentContext, kind: JourneyEntity, id: string): Promise<SupportJourney> {
  const actor = await new EffectiveAccessService(db).forUser(context.actorId, { incidentId: context.incidentId });
  const has = (permission: string) => Boolean(actor?.permissions.includes(permission as never));
  if (!has(journeyReadPermission[kind])) throw new HttpError(403, "Forbidden");
  const incidentId = context.incidentId;
  const root = kind === "enquiry" ? await db.enquiry.findFirst({ where: { id, sessionId: incidentId } })
    : kind === "family" ? await db.familyRecord.findFirst({ where: { id, sessionId: incidentId } })
    : kind === "passenger" ? await db.passengerRecord.findFirst({ where: { id, sessionId: incidentId } })
    : kind === "claim" ? await db.relationshipClaim.findFirst({ where: { id, incidentId, isCurrent: true } })
    : await db.releaseAction.findFirst({ where: { id, incidentId } });
  if (!root) throw new HttpError(404, "Support record not found");
  const incident = await db.session.findUniqueOrThrow({ where: { id: incidentId }, select: { operationalId: true } });
  const reference = "operationalId" in root ? root.operationalId : "Relationship claim";
  const caseReference = "caseId" in root ? root.caseId : null;
  const familyIds = new Set<string>(), passengerIds = new Set<string>(), claimIds = new Set<string>();
  if (kind === "family") familyIds.add(id);
  if (kind === "passenger") passengerIds.add(id);
  if (kind === "claim") claimIds.add(id);
  if ("familyRecordId" in root && root.familyRecordId) familyIds.add(root.familyRecordId);
  if ("passengerRecordId" in root && root.passengerRecordId) passengerIds.add(root.passengerRecordId);
  if ("relationshipClaimId" in root && root.relationshipClaimId) claimIds.add(root.relationshipClaimId);
  // A historical release still resolves the family's current claim for new review.
  if (kind === "release" && "relationshipClaimId" in root && root.relationshipClaimId) {
    const linkedClaim = await db.relationshipClaim.findFirst({ where: { id: root.relationshipClaimId, incidentId }, select: { familyRecordId: true } });
    if (linkedClaim) familyIds.add(linkedClaim.familyRecordId);
  }
  // A shared reference is explicitly weaker than a foreign key, never an identity match.
  const sharedFamilies = kind === "enquiry" ? await db.familyRecord.findMany({ where: { sessionId: incidentId, caseId: { in: [root && "operationalId" in root ? root.operationalId : "", caseReference].filter((v): v is string => Boolean(v)) } }, select: { id: true } }) : [];
  const legacyFamilies = kind === "enquiry" ? await db.matchingRecord.findMany({ where: { sessionId: incidentId, enquiryId: id, familyRecordId: { not: null } }, select: { familyRecordId: true } }) : [];
  for (const row of [...sharedFamilies, ...legacyFamilies.map(row => ({ id: row.familyRecordId! }))]) familyIds.add(row.id);
  const claims = await db.relationshipClaim.findMany({ where: { incidentId, OR: [
    { id: { in: [...claimIds] } }, { familyRecordId: { in: [...familyIds] }, isCurrent: true },
    ...(kind === "passenger" ? [{ passengerRecordId: id, isCurrent: true }] : []),
  ] }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }] });
  for (const claim of claims) { claimIds.add(claim.id); familyIds.add(claim.familyRecordId); if (claim.passengerRecordId) passengerIds.add(claim.passengerRecordId); }
  const decisions = await db.matchDecision.findMany({ where: { incidentId, relationshipClaimId: { in: [...claimIds] }, decision: "CONFIRMED", isCurrent: true }, select: { passengerRecordId: true } });
  decisions.forEach(row => passengerIds.add(row.passengerRecordId));
  const families = await db.familyRecord.findMany({ where: { sessionId: incidentId, id: { in: [...familyIds] } }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }] });
  const references = [...new Set([caseReference, ...families.map(row => row.caseId)].filter((v): v is string => Boolean(v)))];
  const enquiries = has("enquiry:read") ? await db.enquiry.findMany({ where: { sessionId: incidentId, OR: [
    ...(kind === "enquiry" ? [{ id }] : []), { caseId: { in: references } }, { operationalId: { in: references } },
    ...(kind === "passenger" ? [{ passengerRecordId: id }] : []),
  ] }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }] }) : [];
  const passengers = has("passenger:read") ? await db.passengerRecord.findMany({ where: { sessionId: incidentId, id: { in: [...passengerIds] } }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }] }) : [];
  const matching = createPrismaMatchingRepository(db), releasing = createPrismaReleaseRepository(db);
  const matchContexts = has("matching:read") ? (await Promise.all(claims.filter(row => row.isCurrent).slice(0, limit).map(row => matching.getContext(context, row.id)))).filter(row => row !== null) : [];
  const releaseWhere: Prisma.ReleaseActionWhereInput = { incidentId, OR: [
    ...(kind === "release" ? [{ id }] : []), { relationshipClaimId: { in: [...claimIds] } },
    ...(kind === "passenger" ? [{ passengerRecordId: id }] : []),
  ] };
  const releaseRows = has("release:read") ? await db.releaseAction.findMany({ where: releaseWhere, select: { id: true }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: limit }) : [];
  const releaseContexts = (await Promise.all(releaseRows.map(row => releasing.getContext(context, row.id)))).filter(row => row !== null);
  // A bounded display slice cannot establish that no existing release is recorded.
  const activeReleaseClaims = has("release:read") ? new Set((await db.releaseAction.findMany({
    where: { incidentId, relationshipClaimId: { in: [...claimIds] }, status: { not: "CANCELLED" } },
    select: { relationshipClaimId: true }, distinct: ["relationshipClaimId"],
  })).map(row => row.relationshipClaimId)) : new Set<string>();
  const sensitive = has("family:update") || has("passenger:update") || has("matching:verify");
  const steps: JourneyStep[] = [];
  if (kind === "enquiry" && !families.length && has("family:read")) steps.push({ key: "family-follow-up", title: "Family support follow-up", state: "Needs assignment", detail: "No contact is recorded against this enquiry reference. A family support operator must review the reported details; handover does not assign a person or verify a relationship.", expectedRole: "Family support operator", href: has("family:create") && context.writable ? href("/family-nok", "fromEnquiry", id) : null });
  for (const family of families.slice(0, limit)) {
    const claim = claims.find(row => row.familyRecordId === family.id && row.isCurrent);
    if (has("family:read") && claim?.status !== "VERIFIED") steps.push({ key: `relationship-${family.id}`, title: "Relationship verification", state: "Blocked", detail: "The reported relationship has not been verified. A passenger link or match cannot verify it.", expectedRole: "Family support verifier", href: href("/family-nok", "focus", family.id) });
  }
  for (const match of matchContexts) {
    if (match.state !== "CONFIRMED") steps.push({ key: `match-${match.relationshipClaim.id}`, title: "Human match review", state: match.state === "STALE" ? "Stale — review required" : "Blocked", detail: match.state === "STALE" ? "Source or claim facts changed. The historical decision cannot support release." : "No current human-confirmed match. System suggestions are not decisions.", expectedRole: "Match reviewer", href: href("/matching", "claimId", match.relationshipClaim.id) });
    if (has("release:read") && match.state === "CONFIRMED" && !activeReleaseClaims.has(match.relationshipClaim.id)) steps.push({ key: `prepare-${match.relationshipClaim.id}`, title: "Release preparation", state: "Review prerequisites", detail: "A human match is recorded. Relationship verification and release prerequisites remain independent.", expectedRole: "Release preparer", href: href("/release-control", "claimId", match.relationshipClaim.id) });
  }
  for (const release of releaseContexts) {
    if (["COMPLETED", "CANCELLED"].includes(release.status)) continue;
    const currentClaimId = claims.find(row => row.isCurrent && row.familyRecordId === release.relationship?.family.id)?.id;
    for (const check of release.preconditions.filter(row => row.state !== "PASS")) {
      const destination = check.key === "relationship" && has("family:read") && release.relationship ? href("/family-nok", "focus", release.relationship.family.id)
        : ["match", "inputs", "matchingHold"].includes(check.key) && has("matching:read") && release.relationshipClaimId ? href("/matching", "claimId", currentClaimId ?? release.relationshipClaimId)
        : check.key === "passengerHold" && has("passenger:read") && release.passengerRecordId ? href("/passenger-src", "focus", release.passengerRecordId)
        : ["identity", "holdReview"].includes(check.key) ? href("/release-control", "releaseId", release.id) : null;
      steps.push({ key: `${release.id}-${check.key}`, title: check.label, state: check.state, detail: check.key === "passengerHold" && !has("passenger:read") ? "Passenger prerequisite requires an authorized source reviewer." : (operationalActivityText(check.detail) ?? check.label).replaceAll("RelationshipClaim", "Relationship claim").replaceAll("MatchDecision", "Human match decision").replaceAll("Stage 5 matching projection", "Matching record"), expectedRole: ["identity", "holdReview"].includes(check.key) ? "Release checker" : "Authorized specialist", href: destination });
    }
    if (!release.blockers.length) steps.push({ key: `release-${release.id}`, title: release.status === "AUTHORIZED" ? "Record completed handover" : "Human release authorization", state: "Ready for human review", detail: "Passing checks is not authorization or completion. Continue the existing controlled command.", expectedRole: release.status === "AUTHORIZED" ? "Release operator" : "Release authorizer", href: href("/release-control", "releaseId", release.id) });
  }
  const records = {
    enquiries: enquiries.map(row => ({ id: row.id, reference: row.operationalId, title: row.callerName, association: kind === "enquiry" || kind === "passenger" && row.passengerRecordId === id ? "Recorded link" : "Shared reference", href: href("/tec-intake", "focus", row.id), facts: [fact("Reported passenger", [row.passengerFirstName,row.passengerLastName,row.passengerFlight].filter(Boolean).join(" · ")),fact("Reported relationship", row.claimedRelationship),fact("Enquiry / handover", row.status),fact("Reported needs / notes", row.notes)] } as JourneyRecord)),
    families: families.map(row => ({ id: row.id, reference: row.operationalId, title: name(row), association: sharedFamilies.some(item => item.id === row.id) && !legacyFamilies.some(item => item.familyRecordId === row.id) ? "Shared reference" : "Recorded link", href: href("/family-nok", "focus", row.id), facts: [fact("Reported relationship", row.claimedRelationship),fact("Relationship verification", row.verificationStatus),fact("Reported passenger",[row.passengerFirstName,row.passengerLastName,row.passengerFlight].filter(Boolean).join(" · ")),fact("Reported officer (free text)", row.assignedOfficer),fact("Next contact", row.nextContactDue?.toISOString()),...(sensitive ? [fact("Immediate needs", row.immediateNeeds),fact("Commitments",row.commitmentsMade),fact("Notes",row.notes)] : [])] } as JourneyRecord)),
    passengers: passengers.map(row => ({ id: row.id, reference: row.operationalId, title: name(row), association: "Recorded link" as const, href: href("/passenger-src", "focus", row.id), facts: [fact("Flight / route",[row.flightNumber,row.route].filter(Boolean).join(" · ")),fact("Source",row.source),fact("Source confirmation (SRC)",row.srcConfirmed ? "Source confirmed — not relationship verification" : "Source not confirmed"),fact("Passenger hold",row.holdStatus),...(sensitive ? [fact("Condition",row.conditionStatus)] : [])] })),
    matches: matchContexts.map(row => ({ id: row.relationshipClaim.id, reference: has("family:read") ? row.relationshipClaim.family.operationalId : "Relationship claim", title: "Matching / human decision", association: "Recorded link" as const, href: href("/matching", "claimId", row.relationshipClaim.id), facts: [fact("Matching state",row.state),fact("Human decision",row.currentDecision ? `${row.currentDecision.decision} · ${row.currentDecision.effectiveValidity}` : "No current human decision"),fact("System suggestions",`${row.suggestionCount} — never automatic approval`),fact("Suggestion freshness",row.suggestions.some(item => item.isCurrent && item.status === "ACTIVE" && (item.claimVersion !== row.relationshipClaim.version || item.passengerVersion !== item.passenger?.version)) ? "Stale source or claim versions — regenerate before human review" : "Review current versions before a human decision")] })),
    releases: releaseContexts.map(row => ({ id: row.id, reference: row.operationalId, title: row.actionType === "RELEASE" ? "Release" : "Reunification", association: "Recorded link" as const, href: href("/release-control", "releaseId", row.id), facts: [fact("Recorded outcome",row.status),fact("Current prerequisite review",["COMPLETED","CANCELLED"].includes(row.status) ? "Historical outcome; no new action implied" : row.effectiveState)] })),
  };
  const requestWhere: Prisma.RequestWhereInput = { incidentId, status: { notIn: [...workflowStates.terminalRequestStatuses] }, OR: [ { relatedEnquiryId: { in: enquiries.map(row => row.id) } }, { relatedFamilyRecordId: { in: [...familyIds] } }, { relatedPassengerRecordId: { in: [...passengerIds] } }, { relatedReleaseActionId: { in: releaseRows.map(row => row.id) } } ] };
  const requests = has("request:read") ? await db.request.findMany({ where: requestWhere, include: { owner: { select: { displayName: true } } }, orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { id: "asc" }], take: limit }) : [];
  const eligible = await suitableRequestOwnerIds(db,incidentId,requests.flatMap(row => row.ownerUserId ? [row.ownerUserId] : []));
  const followUp = requests.map(row => ({ id: row.id, reference: row.operationalId, title: `${row.category} support`, association: "Recorded link" as const, href: href("/requests","requestId",row.id), facts: [fact("Work state",row.status),fact("Responsible person",row.owner?.displayName ?? (row.legacyOwnerLabel ? "Legacy label — needs assignment" : "Unassigned / needs assignment")),fact("Next action",row.ownerUserId && !eligible.has(row.ownerUserId) ? "Reassignment required" : "Review support request"),fact("Due",row.dueAt?.toISOString())] }));
  const sources = [ ...(has("enquiry:read") ? enquiries.map(row => ({entityType:"enquiry",entityId:row.id})) : []), ...(has("family:read") ? [...familyIds].map(entityId=>({entityType:"familyRecord",entityId})) : []), ...(has("passenger:read") ? passengers.map(row=>({entityType:"passengerRecord",entityId:row.id})) : []), ...(has("matching:read") ? [...claimIds].flatMap(entityId=>[{entityType:"relationshipClaim",entityId}]) : []), ...(has("release:read") ? releaseRows.map(row=>({entityType:"releaseAction",entityId:row.id})) : []) ];
  if(has("matching:read")) { const ids=await db.matchDecision.findMany({where:{incidentId,relationshipClaimId:{in:[...claimIds]}},select:{id:true}}); sources.push(...ids.map(row=>({entityType:"matchDecision",entityId:row.id}))); }
  const events = has("timeline:read") && sources.length ? await db.caseTimelineEvent.findMany({where:{sessionId:incidentId,OR:sources},orderBy:[{occurredAt:"desc"},{id:"desc"}],take:limit}) : [];
  const actorIds = [...new Set(events.flatMap(row => row.createdById ? [row.createdById] : []))];
  const actors = actorIds.length ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } }) : [];
  const activity = events.map(row=>({id:row.id,reference:row.occurredAt.toISOString(),title:operationalActivityText(row.title)??"Operational action",association:"Recorded link" as const,href:href("/timeline","eventId",row.id),facts:[fact("Actor",actors.find(actor => actor.id === row.createdById)?.displayName ?? "System"),...(sensitive ? [fact("Summary",operationalActivityText(row.body))] : [])]}));
  return {loadedAt:new Date().toISOString(), reference,incidentReference:incident.operationalId,
    enquiries:has("enquiry:read")?section(records.enquiries.slice(0,limit),enquiries.length):unavailable,
    families:has("family:read")?section(records.families.slice(0,limit),families.length):unavailable,
    passengers:has("passenger:read")?section(records.passengers.slice(0,limit),passengers.length):unavailable,
    matches:has("matching:read")?section(records.matches,claims.filter(row=>row.isCurrent).length):unavailable,
    releases:has("release:read")?section(records.releases,await db.releaseAction.count({where:releaseWhere})):unavailable,
    followUp:has("request:read")?section(followUp,await db.request.count({where:requestWhere})):unavailable,
    activity:has("timeline:read")?section(activity,sources.length ? await db.caseTimelineEvent.count({where:{sessionId:incidentId,OR:sources}}) : 0):unavailable,steps};
}

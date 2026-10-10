/** Synthetic supplement, explicitly invoked only for the marked disposable preview DB. */
import { PrismaClient } from '@prisma/client';
import assert from 'node:assert/strict';
import { createPrismaPassengerRepository } from '../src/modules/passengers/prisma-passenger-repository.js';
import { createPrismaFamilyRepository } from '../src/modules/families/prisma-family-repository.js';
import { createPrismaMatchingRepository } from '../src/modules/matching/prisma-matching-repository.js';
import { createPrismaEvidenceService } from '../src/modules/evidence/prisma-evidence-service.js';
import { createPrismaEvidenceArtifactStore } from '../src/modules/evidence/evidence-storage.js';
import { validateEvidenceUpload } from '../src/modules/evidence/evidence-types.js';
import { createPrismaAfterActionReportService } from '../src/modules/after-action-reports/prisma-after-action-report-service.js';

const url = new URL(process.env.DATABASE_URL ?? 'file:missing');
if (process.env.NODE_ENV === 'production' || !['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/zpp_connect_preview' || [...url.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public')) throw new Error('Preview seed requires local zpp_connect_preview');
const db = new PrismaClient();
try {
  const [target] = await db.$queryRaw<Array<{ name: string; marker: string }>>`SELECT current_database() AS name, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=current_database()`;
  if (target?.name !== 'zpp_connect_preview' || target.marker !== 'ZPP Connect disposable synthetic local preview') throw new Error('Unmarked preview database');
  const actor = await db.user.findUniqueOrThrow({ where: { email: 'coordinator@lot.pl' } });
  const active = await db.session.update({ where: { operationalId: 'SES-2026-001' }, data: {
    flightNumber: 'LO999', route: 'XYZ-ABC', aircraftRegistration: 'SYNTHETIC', airportLocation: 'Fictional XYZ Airport',
    description: '[SYNTHETIC PREVIEW] LO999 — Operational disruption at XYZ Airport',
    notes: 'Disposable local preview. All records are fictional code fixtures; REAL is the application incident mode, not a real event.',
  } });
  const historical = await db.session.update({ where: { operationalId: 'SES-2026-002' }, data: { description: '[SYNTHETIC PREVIEW] Closed fictional incident for post-incident reporting' } });
  await db.operationalBriefing.update({ where: { id: 'brf-ses-demo-1-r1' }, data: { title: '[SYNTHETIC PREVIEW] Current operational briefing', overview: 'Fictional LO999 XYZ-ABC disruption. All people, operational records and documents are synthetic local fixtures.' } });
  // Keep original fixture relationships while making identities visibly fictional.
  for (const member of await db.memberProfile.findMany({ where: { id: { in: Array.from({ length: 10 }, (_, i) => `mem-2026-${String(i + 1).padStart(6, '0')}`) } }, orderBy: { id: 'asc' } })) {
    await db.memberProfile.update({ where: { id: member.id }, data: { firstName: 'Synthetic', lastName: member.memberId, contactEmail: `${member.memberId.toLowerCase()}@example.test`, normalizedContactEmail: `${member.memberId.toLowerCase()}@example.test`, phone: null } });
  }
  const context = { incidentId: active.id, mode: active.mode, status: active.status, actorId: actor.id, actorEmail: actor.email, systemAdminOverride: false, writable: true };
  const fixtureActor = { ...actor, roles: ['zpp-coordinator'] };
  const passengers = createPrismaPassengerRepository(db);
  const families = createPrismaFamilyRepository(db);
  const matching = createPrismaMatchingRepository(db);
  // Source corrections increment versions and preserve history; approved/decision snapshots stay historical.
  for (const [index, passenger] of (await db.passengerRecord.findMany({ where: { sessionId: active.id }, orderBy: { operationalId: 'asc' } })).entries()) {
    const facts = { firstName: 'Synthetic', lastName: `Passenger ${index + 1}`, flightNumber: 'LO999', route: 'XYZ-ABC' };
    if (Object.entries(facts).some(([key, value]) => passenger[key as keyof typeof passenger] !== value)) {
      const result = await passengers.correctSource(context, passenger.id, { ...facts, reason: 'Synthetic preview lineage correction; no real incident data' }, passenger.version, fixtureActor);
      assert.ok(result.record && !result.conflict, 'Preview passenger correction must succeed');
    }
  }
  for (const [index, family] of (await db.familyRecord.findMany({ where: { sessionId: active.id }, orderBy: { operationalId: 'asc' } })).entries()) {
    const current = await db.relationshipClaim.findFirstOrThrow({ where: { familyRecordId: family.id, isCurrent: true } });
    const passenger = await db.passengerRecord.findUniqueOrThrow({ where: { id: current.passengerRecordId! } });
    const facts = { firstName: 'Synthetic', lastName: `Family ${index + 1}`, email: `family${index + 1}@example.test`, phone: null, passengerFirstName: passenger.firstName, passengerLastName: passenger.lastName, passengerFlight: passenger.flightNumber };
    if (Object.entries(facts).some(([key, value]) => family[key as keyof typeof family] !== value) || current.claimedPassengerFirstName !== passenger.firstName || current.claimedPassengerLastName !== passenger.lastName || current.claimedPassengerFlight !== passenger.flightNumber) {
      const result = await families.correctClaim(context, family.id, { ...facts, reason: 'Synthetic preview claimant/passenger lineage correction' }, family.version, current.version, fixtureActor);
      assert.ok(result.record && !result.conflict, 'Preview claim correction must succeed');
    }
    const claim = await db.relationshipClaim.findFirstOrThrow({ where: { familyRecordId: family.id, isCurrent: true } });
    // Generate genuine deterministic algorithm output, never fabricate scores/signals.
    const suggestions = await matching.generateSuggestions(context, claim.id, { expectedClaimVersion: claim.version }, fixtureActor);
    const suggestion = suggestions.data.find(item => item.passengerRecordId === passenger.id);
    assert.ok(suggestion, 'Linked synthetic passenger must have a current generated suggestion');
    await db.matchingRecord.updateMany({ where: { sessionId: active.id, familyRecordId: family.id, passengerRecordId: passenger.id, status: { in: ['Suggested', 'Potential match', 'Hold / escalate'] } }, data: { relationshipClaimId: claim.id, suggestionId: suggestion.id, matchScore: suggestion.score, matchBasis: '[SYNTHETIC PREVIEW] Current generated candidate; human review still required.' } });
  }
  for (const enquiry of await db.enquiry.findMany({ where: { sessionId: active.id }, orderBy: { operationalId: 'asc' } })) {
    const passenger = await db.passengerRecord.findUniqueOrThrow({ where: { id: enquiry.passengerRecordId! } });
    const claim = await db.relationshipClaim.findFirstOrThrow({ where: { passengerRecordId: passenger.id, isCurrent: true }, include: { familyRecord: true } });
    const family = claim.familyRecord;
    await db.enquiry.update({ where: { id: enquiry.id }, data: { callerName: `${family.firstName} ${family.lastName}`, callerEmail: family.email, callerPhone: null, passengerFirstName: passenger.firstName, passengerLastName: passenger.lastName, passengerFlight: passenger.flightNumber, passengerRoute: passenger.route } });
    assert.equal(claim.claimedPassengerFirstName, passenger.firstName);
    assert.equal(claim.claimedPassengerLastName, passenger.lastName);
    assert.equal(claim.claimedPassengerFlight, passenger.flightNumber);
    const refreshed = await db.enquiry.findUniqueOrThrow({ where: { id: enquiry.id } });
    assert.equal(refreshed.callerName, `${family.firstName} ${family.lastName}`);
    assert.equal(refreshed.passengerLastName, claim.claimedPassengerLastName);
    const suggestion = await db.matchSuggestion.findFirstOrThrow({ where: { relationshipClaimId: claim.id, passengerRecordId: passenger.id, isCurrent: true } });
    assert.equal(suggestion.claimVersion, claim.version);
    assert.equal(suggestion.passengerVersion, passenger.version);
    assert.ok(Array.isArray(suggestion.conflicts) && suggestion.conflicts.length === 0, 'Synthetic principal lineage has no contradictory generated signals');
  }
  await db.request.updateMany({ where: { incidentId: active.id, operationalId: 'REQ-2026-000001' }, data: { requester: 'Synthetic Family 1' } });
  const evidence = createPrismaEvidenceService(db, createPrismaEvidenceArtifactStore(db));
  const bytes = Buffer.from('SYNTHETIC LOCAL PREVIEW ONLY\nFictional LO999 at XYZ Airport. Support desk setup confirmed.\nNo real operational or personal information.\n');
  await evidence.upload({ operationId: '99000000-0000-4000-8000-000000000001', sessionId: active.id, ...validateEvidenceUpload({ bytes, originalName: 'synthetic-preview-note.txt', declaredMimeType: 'text/plain', maxBytes: 4096 }), bytes, category: 'Operational evidence', description: '[SYNTHETIC PREVIEW] Fictional support desk note' }, actor);
  const aar = createPrismaAfterActionReportService(db);
  const created = await aar.create({ operationId: '99000000-0000-4000-8000-000000000002', sessionId: historical.id, title: '[SYNTHETIC PREVIEW] XYZ disruption review', eventDate: '2026-06-20T12:00:00.000Z' }, actor);
  let version = await db.afterActionReportVersion.findUniqueOrThrow({ where: { id: created.reportVersionId! } });
  if (version.status === 'Draft') {
    await aar.edit(version.id, { expectedVersion: version.version, title: '[SYNTHETIC PREVIEW] XYZ disruption review', eventDate: '2026-06-20T12:00:00.000Z', executiveSummary: 'Fictional local preview: the support desk coordinated a controlled handover. No actual incident or person is described.', findings: [{ area: 'Coordination', summary: 'A shared briefing clarified responsibility.' }], lessons: [{ statement: 'Confirm handover ownership before the next operating period.' }], correctiveActions: [{ recommendation: 'Review the synthetic handover checklist.', owner: 'Preview coordinator' }] }, actor);
    version = await db.afterActionReportVersion.findUniqueOrThrow({ where: { id: version.id } });
    await aar.transition(version.id, 'submit', { operationId: '99000000-0000-4000-8000-000000000003', expectedVersion: version.version }, actor);
  }
  version = await db.afterActionReportVersion.findUniqueOrThrow({ where: { id: version.id } });
  if (version.status === 'Under review') await aar.transition(version.id, 'approve', { operationId: '99000000-0000-4000-8000-000000000004', expectedVersion: version.version }, actor);
  console.info('Synthetic preview ready: two REAL-mode incidents, retained text evidence, approved historical AAR. No Training/Exercise data added.');
} finally {
  await db.$disconnect();
}

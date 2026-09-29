/** Synthetic supplement, explicitly invoked only for the marked disposable preview DB. */
import { PrismaClient } from '@prisma/client';
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
  for (const [index, passenger] of (await db.passengerRecord.findMany({ where: { sessionId: active.id }, orderBy: { operationalId: 'asc' } })).entries()) {
    await db.passengerRecord.update({ where: { id: passenger.id }, data: { firstName: 'Synthetic', lastName: `Passenger ${index + 1}`, flightNumber: 'LO999', route: 'XYZ-ABC' } });
  }
  for (const [index, family] of (await db.familyRecord.findMany({ where: { sessionId: active.id }, orderBy: { operationalId: 'asc' } })).entries()) {
    await db.familyRecord.update({ where: { id: family.id }, data: { firstName: 'Synthetic', lastName: `Family ${index + 1}`, email: `family${index + 1}@example.test`, normalizedEmail: `family${index + 1}@example.test`, phone: null, normalizedPhone: null, passengerFirstName: 'Synthetic', passengerLastName: `Passenger ${index + 1}`, passengerFlight: 'LO999' } });
  }
  for (const [index, enquiry] of (await db.enquiry.findMany({ where: { sessionId: active.id }, orderBy: { operationalId: 'asc' } })).entries()) {
    await db.enquiry.update({ where: { id: enquiry.id }, data: { callerName: `Synthetic Family ${index + 1}`, callerEmail: `family${index + 1}@example.test`, callerPhone: null, passengerFirstName: 'Synthetic', passengerLastName: `Passenger ${index + 1}`, passengerFlight: 'LO999', passengerRoute: 'XYZ-ABC' } });
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

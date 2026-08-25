import type { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { authenticate } from "../auth.js";
import type { AssignmentRepository } from "../modules/assignments/assignment-repository.js";
import { createAssignmentRouter } from "../modules/assignments/assignment-router.js";
import { createAssignmentService } from "../modules/assignments/assignment-service.js";
import { createOperationalBriefingRouter } from "../modules/briefings/operational-briefing-router.js";
import type { PrismaOperationalBriefingService } from "../modules/briefings/prisma-operational-briefing-service.js";
import type { FoundationDocumentRepository } from "../modules/documents/document-repository.js";
import { createDocumentRouter } from "../modules/documents/document-router.js";
import { createDocumentService } from "../modules/documents/document-service.js";
import type { EnquiryRepository } from "../modules/enquiries/enquiry-repository.js";
import { createEnquiryRouter } from "../modules/enquiries/enquiry-router.js";
import { createEnquiryService } from "../modules/enquiries/enquiry-service.js";
import { createExerciseRouter } from "../modules/exercise/exercise-router.js";
import type { PrismaExerciseService } from "../modules/exercise/prisma-exercise-service.js";
import { createExportRouter } from "../modules/exports/export-router.js";
import type { PrismaExportService } from "../modules/exports/prisma-export-service.js";
import type { FamilyRepository } from "../modules/families/family-repository.js";
import { createFamilyRouter } from "../modules/families/family-router.js";
import { createFamilyService } from "../modules/families/family-service.js";
import { createIdentityRouter } from "../modules/identity/identity-router.js";
import { EffectiveAccessService } from "../modules/identity/effective-access-service.js";
import type { PrismaImportService } from "../modules/imports/prisma-import-service.js";
import { createImportRouter } from "../modules/imports/import-router.js";
import type { IncidentAccessRepository } from "../modules/incident-access/incident-access-repository.js";
import { createIncidentAccessService } from "../modules/incident-access/incident-access-service.js";
import { createIncidentPermissionGate } from "../modules/incident-access/incident-permission-gate.js";
import type { IncidentAssignmentRepository } from "../modules/incident-assignments/incident-assignment-repository.js";
import { createIncidentAssignmentRouter } from "../modules/incident-assignments/incident-assignment-router.js";
import { createIncidentAssignmentService } from "../modules/incident-assignments/incident-assignment-service.js";
import type { IncidentRepository } from "../modules/incidents/incident-repository.js";
import { createIncidentRouter } from "../modules/incidents/incident-router.js";
import { createIncidentService } from "../modules/incidents/incident-service.js";
import type { MatchingRepository } from "../modules/matching/matching-repository.js";
import { createMatchingRouter } from "../modules/matching/matching-router.js";
import { createMatchingService } from "../modules/matching/matching-service.js";
import type { FoundationMemberDirectoryRepository } from "../modules/member-directory/member-directory-repository.js";
import { createMemberDirectoryRouter } from "../modules/member-directory/member-directory-router.js";
import { createMemberDirectoryService } from "../modules/member-directory/member-directory-service.js";
import { createNotificationRouter } from "../modules/notifications/notification-router.js";
import type { createPersistentNotificationService } from "../modules/notifications/notification-service.js";
import type { PassengerRepository } from "../modules/passengers/passenger-repository.js";
import { createPassengerRouter } from "../modules/passengers/passenger-router.js";
import { createPassengerService } from "../modules/passengers/passenger-service.js";
import { createReadinessRouter } from "../modules/readiness/readiness-router.js";
import type { ReadinessProjectionService } from "../modules/readiness/prisma-readiness-service.js";
import type { ReleaseRepository } from "../modules/releases/release-repository.js";
import { createReleaseRouter } from "../modules/releases/release-router.js";
import { createReleaseService } from "../modules/releases/release-service.js";
import type { RequestRepository } from "../modules/requests/request-repository.js";
import { createRequestRouter } from "../modules/requests/request-router.js";
import { createRequestService } from "../modules/requests/request-service.js";
import type { FoundationRosteringRepository } from "../modules/rostering/rostering-repository.js";
import { createRosteringRouter } from "../modules/rostering/rostering-router.js";
import { createRosteringService } from "../modules/rostering/rostering-service.js";
import type { FoundationTrainingRepository } from "../modules/training/training-repository.js";
import { createTrainingRouter } from "../modules/training/training-router.js";
import { createTrainingService } from "../modules/training/training-service.js";
import { createProductionRouteRegistry } from "./production-route-registry.js";
import { createDeferredProductionRouter, createProductionSharedRouter, createPublicProductionRouter } from "./production-shared-router.js";

type NotificationService = ReturnType<typeof createPersistentNotificationService>;

export type ProductionCompositionOptions = {
  db: PrismaClient;
  incidentRepository: IncidentRepository;
  enquiryRepository: EnquiryRepository;
  incidentAccessRepository: IncidentAccessRepository;
  incidentAssignmentRepository: IncidentAssignmentRepository;
  passengerRepository: PassengerRepository;
  familyRepository: FamilyRepository;
  matchingRepository: MatchingRepository;
  releaseRepository: ReleaseRepository;
  requestRepository: RequestRepository;
  assignmentRepository: AssignmentRepository;
  memberDirectoryRepository: FoundationMemberDirectoryRepository;
  rosteringRepository: FoundationRosteringRepository;
  trainingRepository: FoundationTrainingRepository;
  documentRepository: FoundationDocumentRepository;
  notificationService: NotificationService;
  operationalBriefingService: PrismaOperationalBriefingService;
  importService: PrismaImportService;
  exportService: PrismaExportService;
  exerciseService: PrismaExerciseService;
  readinessService: ReadinessProjectionService;
  trainingClock?: { now(): Date };
  documentClock?: { now(): Date };
  documentNotificationHook?: (record: Record<string, unknown>) => void;
  assignmentNotificationHook?: (record: Record<string, unknown>, command: string) => void;
  rosteringNotificationHook?: (record: Record<string, unknown>, command: string) => void;
  trainingNotificationHook?: (record: Record<string, unknown>, command: string) => void;
};

export function createProductionComposition(options: ProductionCompositionOptions) {
  const router = Router();
  const registry = createProductionRouteRegistry();
  const mount = (
    owner: string,
    category: "A" | "E" | "F",
    authority: "postgres" | "stateless" | "deferred",
    child: Router,
  ) => {
    registry.claimRouter(owner, category, authority, child);
    router.use(child);
  };

  const publicRoutes = createPublicProductionRouter();
  mount("production-public", "E", "stateless", publicRoutes);
  registry.claim({ method: "GET", path: "/docs/*", owner: "production-public", category: "E", authority: "stateless" });
  mount("identity", "A", "postgres", createIdentityRouter(options.db));
  router.use(authenticate);

  const incidentAccess = createIncidentAccessService(options.incidentAccessRepository);
  const effectiveAccess = new EffectiveAccessService(options.db);
  const requireIncidentPermission = createIncidentPermissionGate(effectiveAccess, incidentAccess);
  mount("production-shared", "E", "postgres", createProductionSharedRouter(options.db, requireIncidentPermission));
  mount("admin-dictionaries-deferred", "F", "deferred", createDeferredProductionRouter());
  mount("incidents", "A", "postgres", createIncidentRouter(createIncidentService(options.incidentRepository, incidentAccess), {
    requireIncidentPermission,
    effectiveIncidentIdsForPermission: (userId) => effectiveAccess.effectiveIncidentIdsForPermission(userId, "session:read"),
  }));
  mount("incident-assignments", "A", "postgres", createIncidentAssignmentRouter(createIncidentAssignmentService(options.incidentAssignmentRepository, incidentAccess), requireIncidentPermission));
  mount("enquiries", "A", "postgres", createEnquiryRouter(createEnquiryService(options.enquiryRepository, incidentAccess), { requireIncidentPermission }));
  mount("passengers", "A", "postgres", createPassengerRouter(createPassengerService(options.passengerRepository, incidentAccess), { requireIncidentPermission }));
  mount("families", "A", "postgres", createFamilyRouter(createFamilyService(options.familyRepository, incidentAccess), { requireIncidentPermission }));
  mount("matching", "A", "postgres", createMatchingRouter(createMatchingService(options.matchingRepository, incidentAccess), { requireIncidentPermission }));
  mount("releases", "A", "postgres", createReleaseRouter(createReleaseService(options.releaseRepository, incidentAccess), { requireIncidentPermission }));
  mount("requests", "A", "postgres", createRequestRouter(createRequestService(options.requestRepository, incidentAccess), { requireIncidentPermission }));
  mount("assignments", "A", "postgres", createAssignmentRouter(createAssignmentService(options.assignmentRepository, incidentAccess), {
    requireIncidentPermission,
    onCommitted: (record, command) => options.assignmentNotificationHook?.(record, command),
  }));
  mount("member-directory", "A", "postgres", createMemberDirectoryRouter(createMemberDirectoryService(options.memberDirectoryRepository, incidentAccess), { requireIncidentPermission }));
  mount("rostering", "A", "postgres", createRosteringRouter(createRosteringService(options.rosteringRepository, incidentAccess), {
    requireIncidentPermission,
    onShiftCommitted: (record, command) => options.rosteringNotificationHook?.(record, command),
  }));
  mount("training", "A", "postgres", createTrainingRouter(createTrainingService(options.trainingRepository, incidentAccess, options.trainingClock), {
    onAssigned: (record) => options.trainingNotificationHook?.(record, "assign"),
  }));
  mount("documents", "A", "postgres", createDocumentRouter(createDocumentService(options.documentRepository, incidentAccess, options.documentClock), {
    onPublished: (record) => options.documentNotificationHook?.(record),
  }));
  mount("notifications", "A", "postgres", createNotificationRouter(options.notificationService));
  mount("operational-briefings", "A", "postgres", createOperationalBriefingRouter(options.operationalBriefingService, requireIncidentPermission));
  mount("imports", "A", "postgres", createImportRouter(options.importService, requireIncidentPermission));
  mount("exports-reports", "A", "postgres", createExportRouter(options.exportService, requireIncidentPermission));
  mount("exercise", "A", "postgres", createExerciseRouter(options.exerciseService, requireIncidentPermission));
  mount("readiness", "A", "postgres", createReadinessRouter(options.readinessService));

  return { router, manifest: registry.manifest() };
}

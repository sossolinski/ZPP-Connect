import type { Express } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AssignmentRepository } from "../modules/assignments/assignment-repository.js";
import { createPrismaAssignmentRepository } from "../modules/assignments/prisma-assignment-repository.js";
import { createPrismaOperationalBriefingService, type PrismaOperationalBriefingService } from "../modules/briefings/prisma-operational-briefing-service.js";
import type { DictionaryConfigurationService } from "../modules/configuration/configuration-types.js";
import { createPrismaDictionaryService } from "../modules/configuration/prisma-dictionary-service.js";
import type { FoundationDocumentRepository } from "../modules/documents/document-repository.js";
import { createPrismaDocumentRepository } from "../modules/documents/prisma-document-repository.js";
import type { EnquiryRepository } from "../modules/enquiries/enquiry-repository.js";
import { createPrismaEnquiryRepository } from "../modules/enquiries/prisma-enquiry-repository.js";
import { createPrismaExerciseService, type PrismaExerciseService } from "../modules/exercise/prisma-exercise-service.js";
import { createPrismaExportService, type PrismaExportService } from "../modules/exports/prisma-export-service.js";
import type { FamilyRepository } from "../modules/families/family-repository.js";
import { createPrismaFamilyRepository } from "../modules/families/prisma-family-repository.js";
import { createPrismaImportService, type PrismaImportService } from "../modules/imports/prisma-import-service.js";
import type { IncidentAccessRepository } from "../modules/incident-access/incident-access-repository.js";
import { createPrismaIncidentAccessRepository } from "../modules/incident-access/prisma-incident-access-repository.js";
import type { IncidentAssignmentRepository } from "../modules/incident-assignments/incident-assignment-repository.js";
import { createPrismaIncidentAssignmentRepository } from "../modules/incident-assignments/prisma-incident-assignment-repository.js";
import type { IncidentRepository } from "../modules/incidents/incident-repository.js";
import { createPrismaIncidentRepository } from "../modules/incidents/prisma-incident-repository.js";
import type { MatchingRepository } from "../modules/matching/matching-repository.js";
import { createPrismaMatchingRepository } from "../modules/matching/prisma-matching-repository.js";
import type { FoundationMemberDirectoryRepository } from "../modules/member-directory/member-directory-repository.js";
import { createPrismaMemberDirectoryRepository } from "../modules/member-directory/prisma-member-directory-repository.js";
import { createNotificationDispatcher } from "../modules/notifications/notification-dispatcher.js";
import { createNotificationProjector } from "../modules/notifications/notification-projector.js";
import type { NotificationRepository } from "../modules/notifications/notification-repository.js";
import { createPrismaNotificationRepository } from "../modules/notifications/prisma-notification-repository.js";
import { createNotificationRuntime } from "../modules/notifications/notification-runtime.js";
import { createPersistentNotificationService } from "../modules/notifications/notification-service.js";
import type { PassengerRepository } from "../modules/passengers/passenger-repository.js";
import { createPrismaPassengerRepository } from "../modules/passengers/prisma-passenger-repository.js";
import { createPrismaReadinessProjectionService, type ReadinessProjectionService } from "../modules/readiness/prisma-readiness-service.js";
import type { ReleaseRepository } from "../modules/releases/release-repository.js";
import { createPrismaReleaseRepository } from "../modules/releases/prisma-release-repository.js";
import type { RequestRepository } from "../modules/requests/request-repository.js";
import { createPrismaRequestRepository } from "../modules/requests/prisma-request-repository.js";
import type { FoundationRosteringRepository } from "../modules/rostering/rostering-repository.js";
import { createPrismaRosteringRepository } from "../modules/rostering/prisma-rostering-repository.js";
import type { FoundationTrainingRepository } from "../modules/training/training-repository.js";
import { createPrismaTrainingRepository } from "../modules/training/prisma-training-repository.js";
import { prisma } from "../prisma.js";
import { createProductionComposition } from "./production-composition.js";

const createMemoryTestRouter = config.persistenceMode === "memory"
  ? (await import("../demo-router.js")).createDemoRouter
  : undefined;

export type RouteOptions = {
  incidentRepository?: IncidentRepository;
  enquiryRepository?: EnquiryRepository;
  incidentAccessRepository?: IncidentAccessRepository;
  incidentAssignmentRepository?: IncidentAssignmentRepository;
  passengerRepository?: PassengerRepository;
  familyRepository?: FamilyRepository;
  matchingRepository?: MatchingRepository;
  releaseRepository?: ReleaseRepository;
  requestRepository?: RequestRepository;
  assignmentRepository?: AssignmentRepository;
  memberDirectoryRepository?: FoundationMemberDirectoryRepository;
  rosteringRepository?: FoundationRosteringRepository;
  trainingRepository?: FoundationTrainingRepository;
  trainingClock?: { now(): Date };
  documentRepository?: FoundationDocumentRepository;
  notificationRepository?: NotificationRepository;
  operationalBriefingService?: PrismaOperationalBriefingService;
  importService?: PrismaImportService;
  exportService?: PrismaExportService;
  exerciseService?: PrismaExerciseService;
  readinessService?: ReadinessProjectionService;
  dictionaryService?: DictionaryConfigurationService;
  documentClock?: { now(): Date };
  documentNotificationHook?: (record: Record<string, unknown>) => void;
  assignmentNotificationHook?: (record: Record<string, unknown>, command: string) => void;
  rosteringNotificationHook?: (record: Record<string, unknown>, command: string) => void;
  trainingNotificationHook?: (record: Record<string, unknown>, command: string) => void;
};

function requestsPostgres(options: RouteOptions) {
  return config.persistenceMode === "postgres" || [
    options.incidentRepository, options.enquiryRepository,
    options.incidentAssignmentRepository, options.passengerRepository, options.familyRepository,
    options.matchingRepository, options.releaseRepository, options.requestRepository,
    options.assignmentRepository, options.memberDirectoryRepository, options.rosteringRepository,
    options.trainingRepository, options.documentRepository, options.notificationRepository,
    options.operationalBriefingService, options.importService, options.exportService,
    options.exerciseService, options.readinessService,
    options.dictionaryService,
  ].some((candidate) => candidate && "kind" in candidate && candidate.kind === "postgres");
}

export function registerRoutes(app: Express, options: RouteOptions = {}) {
  if (!requestsPostgres(options)) {
    if (!createMemoryTestRouter) throw new Error("The memory router is available only when PERSISTENCE_MODE=memory");
    app.locals.productionComposition = "memory-test-only";
    app.locals.legacyMemoryModuleLoaded = true;
    app.locals.legacyMemoryRouterMounted = true;
    app.use("/api", createMemoryTestRouter({
      ...options,
      notificationService: options.notificationRepository ? createPersistentNotificationService(options.notificationRepository) : undefined,
    }));
    return;
  }

  const incidentRepository = options.incidentRepository ?? createPrismaIncidentRepository(prisma);
  const enquiryRepository = options.enquiryRepository ?? createPrismaEnquiryRepository(prisma);
  const incidentAccessRepository = options.incidentAccessRepository ?? createPrismaIncidentAccessRepository(prisma);
  const incidentAssignmentRepository = options.incidentAssignmentRepository ?? createPrismaIncidentAssignmentRepository(prisma);
  const passengerRepository = options.passengerRepository ?? createPrismaPassengerRepository(prisma);
  const familyRepository = options.familyRepository ?? createPrismaFamilyRepository(prisma);
  const matchingRepository = options.matchingRepository ?? createPrismaMatchingRepository(prisma);
  const releaseRepository = options.releaseRepository ?? createPrismaReleaseRepository(prisma);
  const requestRepository = options.requestRepository ?? createPrismaRequestRepository(prisma);
  const assignmentRepository = options.assignmentRepository ?? createPrismaAssignmentRepository(prisma);
  const trainingRepository = options.trainingRepository ?? createPrismaTrainingRepository(prisma, options.trainingClock);
  const memberDirectoryRepository = options.memberDirectoryRepository ?? createPrismaMemberDirectoryRepository(
    prisma,
    (memberProfileId) => trainingRepository.memberTrainingStatus(memberProfileId, options.trainingClock?.now() ?? new Date()),
  );
  const rosteringRepository = options.rosteringRepository ?? createPrismaRosteringRepository(prisma);
  const documentRepository = options.documentRepository ?? createPrismaDocumentRepository(prisma, options.documentClock);
  const notificationRepository = options.notificationRepository ?? createPrismaNotificationRepository(prisma);
  const notificationService = createPersistentNotificationService(notificationRepository);
  const operationalBriefingService = options.operationalBriefingService ?? createPrismaOperationalBriefingService(prisma);
  const importService = options.importService ?? createPrismaImportService(prisma);
  const exportService = options.exportService ?? createPrismaExportService(prisma);
  const exerciseService = options.exerciseService ?? createPrismaExerciseService(prisma);
  const readinessService = options.readinessService ?? createPrismaReadinessProjectionService(prisma, options.trainingClock);
  const dictionaryService = options.dictionaryService ?? createPrismaDictionaryService(prisma);
  const composition = createProductionComposition({
    db: prisma,
    incidentRepository, enquiryRepository, incidentAccessRepository, incidentAssignmentRepository,
    passengerRepository, familyRepository, matchingRepository, releaseRepository, requestRepository,
    assignmentRepository, memberDirectoryRepository, rosteringRepository, trainingRepository,
    documentRepository, notificationService, operationalBriefingService, importService, exportService,
    exerciseService, readinessService, dictionaryService,
    trainingClock: options.trainingClock,
    documentClock: options.documentClock,
    documentNotificationHook: options.documentNotificationHook,
    assignmentNotificationHook: options.assignmentNotificationHook,
    rosteringNotificationHook: options.rosteringNotificationHook,
    trainingNotificationHook: options.trainingNotificationHook,
  });
  app.locals.productionComposition = "postgres-explicit";
  app.locals.legacyMemoryModuleLoaded = Boolean(createMemoryTestRouter);
  app.locals.legacyMemoryRouterMounted = false;
  app.locals.productionRouteManifest = composition.manifest;
  app.use("/api", composition.router);

  if (notificationRepository.kind === "postgres") {
    const dispatcher = createNotificationDispatcher(prisma, notificationRepository, { batchSize: config.notificationDispatchBatchSize, logger });
    const projector = createNotificationProjector(prisma, notificationRepository, { training: trainingRepository, documents: documentRepository, batchSize: config.notificationProjectBatchSize, maxRows: config.notificationProjectMaxRows });
    app.locals.notificationRuntime = createNotificationRuntime({ dispatcher, projector, logger, dispatchIntervalMs: config.notificationDispatchIntervalMs, projectIntervalMs: config.notificationProjectIntervalMs });
    app.locals.notificationDispatcher = dispatcher;
    app.locals.notificationProjector = projector;
  }
}

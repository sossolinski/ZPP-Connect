import crypto from "node:crypto";
import compression from "compression";
import cors from "cors";
import express from "express";
import type { Request } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { config, validateRuntimeConfig } from "./config.js";
import { errorHandler, notFound } from "./errors.js";
import { logger } from "./logger.js";
import { registerRoutes } from "./routes/index.js";
import type { IncidentRepository } from "./modules/incidents/incident-repository.js";
import type { EnquiryRepository } from "./modules/enquiries/enquiry-repository.js";
import type { IncidentAccessRepository } from "./modules/incident-access/incident-access-repository.js";
import type { IncidentAssignmentRepository } from "./modules/incident-assignments/incident-assignment-repository.js";
import type { PassengerRepository } from "./modules/passengers/passenger-repository.js";
import type { FamilyRepository } from "./modules/families/family-repository.js";
import type { MatchingRepository } from "./modules/matching/matching-repository.js";
import type { ReleaseRepository } from "./modules/releases/release-repository.js";
import type { RequestRepository } from "./modules/requests/request-repository.js";
import type { AssignmentRepository } from "./modules/assignments/assignment-repository.js";
import type { FoundationMemberDirectoryRepository } from "./modules/member-directory/member-directory-repository.js";
import type { FoundationRosteringRepository } from "./modules/rostering/rostering-repository.js";
import type { FoundationTrainingRepository } from "./modules/training/training-repository.js";
import type { FoundationDocumentRepository } from "./modules/documents/document-repository.js";
import type { NotificationRepository } from "./modules/notifications/notification-repository.js";
import type { PrismaOperationalBriefingService } from "./modules/briefings/prisma-operational-briefing-service.js";

export function createApp(options: {
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
  documentClock?: { now(): Date };
  documentNotificationHook?: (record: Record<string, unknown>) => void;
  assignmentNotificationHook?: (record: Record<string, unknown>, command: string) => void;
  rosteringNotificationHook?: (record: Record<string, unknown>, command: string) => void;
  trainingNotificationHook?: (record: Record<string, unknown>, command: string) => void;
  skipRuntimeValidation?: boolean;
} = {}) {
  if (!options.skipRuntimeValidation) validateRuntimeConfig(config);
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use((req, _res, next) => {
    req.requestId = crypto.randomUUID();
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).requestId ?? crypto.randomUUID()
    })
  );
  app.use(helmet());
  app.use(compression());
  app.use(
    cors({
      origin: config.appOrigin.split(",").map((origin) => origin.trim()),
      credentials: true
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  registerRoutes(app, {
    incidentRepository: options.incidentRepository,
    enquiryRepository: options.enquiryRepository,
    incidentAccessRepository: options.incidentAccessRepository,
    incidentAssignmentRepository: options.incidentAssignmentRepository,
    passengerRepository: options.passengerRepository,
    familyRepository: options.familyRepository,
    matchingRepository: options.matchingRepository,
    releaseRepository: options.releaseRepository,
    requestRepository: options.requestRepository,
    assignmentRepository: options.assignmentRepository,
    memberDirectoryRepository: options.memberDirectoryRepository,
    rosteringRepository: options.rosteringRepository,
    trainingRepository: options.trainingRepository,
    trainingClock: options.trainingClock,
    documentRepository: options.documentRepository,
    notificationRepository: options.notificationRepository,
    operationalBriefingService: options.operationalBriefingService,
    documentClock: options.documentClock,
    documentNotificationHook: options.documentNotificationHook,
    assignmentNotificationHook: options.assignmentNotificationHook,
    rosteringNotificationHook: options.rosteringNotificationHook,
    trainingNotificationHook: options.trainingNotificationHook
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

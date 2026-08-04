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

export function createApp(options: {
  incidentRepository?: IncidentRepository;
  enquiryRepository?: EnquiryRepository;
  incidentAccessRepository?: IncidentAccessRepository;
  incidentAssignmentRepository?: IncidentAssignmentRepository;
  passengerRepository?: PassengerRepository;
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
    passengerRepository: options.passengerRepository
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

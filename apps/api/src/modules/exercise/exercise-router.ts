import type { Request, RequestHandler } from "express";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, HttpError } from "../../errors.js";
import type { IncidentPermissionGate } from "../incident-access/incident-permission-gate.js";
import {
  exerciseInjectStatuses,
  observationAreas,
  observationSeverities,
  observationStatuses,
  type ExerciseActor
} from "./exercise-types.js";
import type { PrismaExerciseService } from "./prisma-exercise-service.js";

const uuid = z.string().uuid();
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional().transform((value) => value === "" ? null : value);
const scenarioTime = z.string().datetime({ offset: true }).nullable().optional();
const expectedVersion = z.number().int().positive();
const page = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) });
const injectList = page.extend({ sessionId: uuid, status: z.enum(exerciseInjectStatuses).optional() });
const observationList = page.extend({ sessionId: uuid, status: z.enum(observationStatuses).optional() });
const createInject = z.object({
  sessionId: uuid, operationId: uuid, injectNumber: z.number().int().min(1).max(999999),
  scenarioTime, targetRole: z.string().trim().min(1).max(100), text: z.string().trim().min(1).max(10000),
  expectedAction: nullableText(5000)
}).strict();
const updateInject = z.object({
  expectedVersion, injectNumber: z.number().int().min(1).max(999999).optional(), scenarioTime,
  targetRole: z.string().trim().min(1).max(100).optional(), text: z.string().trim().min(1).max(10000).optional(),
  expectedAction: nullableText(5000)
}).strict();
const createObservation = z.object({
  sessionId: uuid, operationId: uuid, area: z.enum(observationAreas), severity: z.enum(observationSeverities).default("Low"),
  observation: z.string().trim().min(1).max(10000), recommendation: nullableText(5000), owner: nullableText(200),
  includeInAar: z.boolean().default(true), status: z.enum(observationStatuses).default("Open")
}).strict();
const updateObservation = z.object({
  expectedVersion, area: z.enum(observationAreas).optional(), severity: z.enum(observationSeverities).optional(),
  observation: z.string().trim().min(1).max(10000).optional(), recommendation: nullableText(5000), owner: nullableText(200),
  includeInAar: z.boolean().optional(), status: z.enum(observationStatuses).optional()
}).strict();
const action = z.object({ expectedVersion: expectedVersion.optional() }).strict();

function actor(req: Request): ExerciseActor {
  if (!req.user) throw new HttpError(401, "Authentication required");
  return { id: req.user.id, email: req.user.email, displayName: req.user.displayName, requestId: req.requestId };
}

export function createExerciseRouter(service: PrismaExerciseService, requireIncidentPermission: IncidentPermissionGate) {
  const router = Router();
  const injectContexts = new WeakMap<Request, { id: string; sessionId: string }>();
  const observationContexts = new WeakMap<Request, { id: string; sessionId: string }>();

  const loadInject = asyncHandler(async (req, _res, next) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, "Exercise Inject not found");
    injectContexts.set(req, await service.injectContext(id.data)); next();
  });
  const loadObservation = asyncHandler(async (req, _res, next) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, "Exercise Observation not found");
    observationContexts.set(req, await service.observationContext(id.data)); next();
  });
  const injectContext = (req: Request) => injectContexts.get(req) ?? (() => { throw new HttpError(404, "Exercise Inject not found"); })();
  const observationContext = (req: Request) => observationContexts.get(req) ?? (() => { throw new HttpError(404, "Exercise Observation not found"); })();
  const antiEnumeration = (handler: RequestHandler): RequestHandler => (req, res, next) => handler(req, res, (error?: unknown) => {
    if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return next(new HttpError(404, "Exercise evidence not found"));
    next(error);
  });
  const injectGate = (writable: boolean) => antiEnumeration(requireIncidentPermission("exercise:manage", (req) => injectContext(req).sessionId, { requireWritable: writable }));
  const observationGate = (writable: boolean) => antiEnumeration(requireIncidentPermission("exercise:manage", (req) => observationContext(req).sessionId, { requireWritable: writable }));

  router.get("/exercise/injects", requireIncidentPermission("exercise:manage", (req) => String(req.query.sessionId ?? "")), asyncHandler(async (req, res) => {
    res.json(await service.listInjects(injectList.parse(req.query), actor(req)));
  }));
  router.post("/exercise/injects", requireIncidentPermission("exercise:manage", (req) => String(req.body?.sessionId ?? ""), { requireWritable: true }), asyncHandler(async (req, res) => {
    const parsed = createInject.parse(req.body);
    const result = await service.createInject({ ...parsed, scenarioTime: parsed.scenarioTime ? new Date(parsed.scenarioTime) : null, expectedAction: parsed.expectedAction ?? null }, actor(req));
    res.status(result.replayed ? 200 : 201).json(result.record);
  }));
  router.patch("/exercise/injects/:id", loadInject, injectGate(true), asyncHandler(async (req, res) => {
    const parsed = updateInject.parse(req.body);
    const { scenarioTime: rawScenarioTime, ...fields } = parsed;
    res.json(await service.updateInject(injectContext(req).id, { ...fields, ...(rawScenarioTime !== undefined ? { scenarioTime: rawScenarioTime ? new Date(rawScenarioTime) : null } : {}) }, actor(req)));
  }));
  router.post("/exercise/injects/:id/release", loadInject, injectGate(true), asyncHandler(async (req, res) => {
    const body = action.parse(req.body ?? {});
    res.json(await service.releaseInject(injectContext(req).id, body.expectedVersion, actor(req)));
  }));
  router.post("/exercise/injects/:id/complete", loadInject, injectGate(true), asyncHandler(async (req, res) => {
    const body = action.parse(req.body ?? {});
    res.json(await service.completeInject(injectContext(req).id, body.expectedVersion, actor(req)));
  }));

  router.get("/exercise/observations", requireIncidentPermission("exercise:manage", (req) => String(req.query.sessionId ?? "")), asyncHandler(async (req, res) => {
    res.json(await service.listObservations(observationList.parse(req.query), actor(req)));
  }));
  router.post("/exercise/observations", requireIncidentPermission("exercise:manage", (req) => String(req.body?.sessionId ?? ""), { requireWritable: true }), asyncHandler(async (req, res) => {
    const parsed = createObservation.parse(req.body);
    const result = await service.createObservation({ ...parsed, recommendation: parsed.recommendation ?? null, owner: parsed.owner ?? null }, actor(req));
    res.status(result.replayed ? 200 : 201).json(result.record);
  }));
  router.patch("/exercise/observations/:id", loadObservation, observationGate(true), asyncHandler(async (req, res) => {
    res.json(await service.updateObservation(observationContext(req).id, updateObservation.parse(req.body), actor(req)));
  }));
  router.get("/exercise/observations/:id/history", loadObservation, observationGate(false), asyncHandler(async (req, res) => {
    res.json(await service.observationHistory(observationContext(req).id, page.parse(req.query), actor(req)));
  }));

  return router;
}

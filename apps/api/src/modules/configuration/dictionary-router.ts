import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../errors.js";
import { requirePermission } from "../../rbac.js";
import { dictionaryPolicies, profileDictionaryPolicy } from "./dictionary-policy.js";
import type { DictionaryActor, DictionaryConfigurationService } from "./configuration-types.js";

const page = z.object({
  category: z.string().trim().min(1).max(100).optional(),
  active: z.enum(["true", "false"]).optional().transform((value) => value === undefined ? undefined : value === "true"),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const create = z.object({
  category: z.string().trim().min(1).max(100),
  key: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1_000).optional().nullable(),
  sortOrder: z.coerce.number().int().min(-1_000_000).max(1_000_000).optional(),
}).strict();
const update = z.object({
  expectedVersion: z.coerce.number().int().min(1),
  label: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1_000).optional().nullable(),
  sortOrder: z.coerce.number().int().min(-1_000_000).max(1_000_000).optional(),
}).strict().refine((value) => value.label !== undefined || value.description !== undefined || value.sortOrder !== undefined, {
  message: "At least one mutable field is required.",
});
const version = z.object({ expectedVersion: z.coerce.number().int().min(1) }).strict();

function actor(req: Request): DictionaryActor {
  if (!req.user) throw new Error("Authenticated actor is required");
  return { id: req.user.id, email: req.user.email, displayName: req.user.displayName };
}

export function createDictionaryRouter(service: DictionaryConfigurationService) {
  const router = Router();

  router.get("/dictionaries", asyncHandler(async (_req, res) => {
    res.json(await service.publicDictionaries());
  }));

  router.get(
    "/admin/dictionary-policies",
    requirePermission("admin:manage"),
    (_req, res) => res.json({
      data: [...Object.values(dictionaryPolicies), profileDictionaryPolicy]
        .sort((left, right) => left.category.localeCompare(right.category)),
    }),
  );

  router.get(
    "/admin/dictionaries",
    requirePermission("admin:manage"),
    asyncHandler(async (req, res) => {
      res.json(await service.listAdmin(page.parse(req.query)));
    }),
  );

  router.post(
    "/admin/dictionaries",
    requirePermission("admin:manage"),
    asyncHandler(async (req, res) => {
      res.status(201).json(await service.create(create.parse(req.body), actor(req)));
    }),
  );

  router.patch(
    "/admin/dictionaries/:id",
    requirePermission("admin:manage"),
    asyncHandler(async (req, res) => {
      res.json(await service.update(String(req.params.id), update.parse(req.body), actor(req)));
    }),
  );

  for (const [command, active] of [["deactivate", false], ["reactivate", true]] as const) {
    router.post(
      `/admin/dictionaries/:id/${command}`,
      requirePermission("admin:manage"),
      asyncHandler(async (req, res) => {
        res.json(await service.setActive(String(req.params.id), { ...version.parse(req.body), active }, actor(req)));
      }),
    );
  }

  return router;
}

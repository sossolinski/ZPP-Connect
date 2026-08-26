import { Prisma, type PrismaClient } from "@prisma/client";
import { defaultProfile, dictionaries } from "@zpp/shared";
import { HttpError } from "../../errors.js";
import {
  dictionaryPolicies,
  dictionaryPolicy,
  normalizeDictionaryKey,
} from "./dictionary-policy.js";
import type {
  DictionaryActor,
  DictionaryAdminRecord,
  DictionaryConfigurationService,
  DictionaryFailurePoint,
  DictionaryPolicy,
  PublicDictionaryItem,
} from "./configuration-types.js";

type ServiceOptions = {
  failAt?: (point: DictionaryFailurePoint) => void | Promise<void>;
};

function withPolicy<T extends { category: string }>(record: T): T & { policy: DictionaryPolicy } {
  return { ...record, policy: dictionaryPolicy(record.category) };
}

function validatePolicyMutation(policy: DictionaryPolicy, operation: "create" | "update" | "deactivate" | "reactivate") {
  const allowed = operation === "create"
    ? policy.allowCreate
    : operation === "update"
      ? policy.allowLabelEdit || policy.allowDescriptionEdit || policy.allowReorder
      : operation === "deactivate"
        ? policy.allowDeactivate
        : policy.allowReactivate;
  if (!allowed) throw new HttpError(409, `Dictionary category '${policy.category}' is protected and does not allow ${operation}.`);
}

function validateText(value: string, field: string, max: number) {
  const clean = value.trim();
  if (!clean) throw new HttpError(400, `${field} is required.`);
  if (clean.length > max) throw new HttpError(400, `${field} must not exceed ${max} characters.`);
  return clean;
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isSerializableConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

export function createPrismaDictionaryService(
  db: PrismaClient,
  options: ServiceOptions = {},
): DictionaryConfigurationService {
  const profile = defaultProfile.id;
  const fail = async (point: DictionaryFailurePoint) => options.failAt?.(point);

  async function mutation<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async function findMutable(tx: Prisma.TransactionClient, id: string) {
    const record = await tx.dictionary.findFirst({ where: { id, profile } });
    if (!record) throw new HttpError(404, "Dictionary value not found.");
    return { record, policy: dictionaryPolicy(record.category) };
  }

  async function audit(
    tx: Prisma.TransactionClient,
    actor: DictionaryActor,
    record: { id: string; category: string; key: string; profile: string; version: number },
    operation: string,
    previousVersion: number | null,
  ) {
    await fail("duringAudit");
    await tx.auditLog.create({
      data: {
        action: "dictionary_change",
        entityType: "Dictionary",
        entityId: record.id,
        actorId: actor.id,
        actorEmail: actor.email,
        summary: `Dictionary ${operation}: ${record.category}/${record.key}`,
        metadata: {
          profile: record.profile,
          category: record.category,
          key: record.key,
          operation,
          previousVersion,
          resultingVersion: record.version,
        },
      },
    });
  }

  return {
    kind: "postgres",

    async listAdmin(query) {
      const where: Prisma.DictionaryWhereInput = {
        profile,
        ...(query.category ? { category: query.category } : {}),
        ...(query.active === undefined ? {} : { isActive: query.active }),
        ...(query.search ? {
          OR: [
            { category: { contains: query.search, mode: "insensitive" } },
            { key: { contains: query.search, mode: "insensitive" } },
            { label: { contains: query.search, mode: "insensitive" } },
            { description: { contains: query.search, mode: "insensitive" } },
          ],
        } : {}),
      };
      const [total, rows] = await Promise.all([
        db.dictionary.count({ where }),
        db.dictionary.findMany({
          where,
          orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { label: "asc" }, { key: "asc" }],
          take: query.limit,
          skip: query.offset,
        }),
      ]);
      return {
        total,
        limit: query.limit,
        offset: query.offset,
        data: rows.map(withPolicy),
      };
    },

    async publicDictionaries() {
      const response: Record<string, PublicDictionaryItem[]> = {};
      for (const [category, values] of Object.entries(dictionaries)) {
        const policy = dictionaryPolicies[category as keyof typeof dictionaryPolicies];
        if (!policy.publicExposed) continue;
        if (policy.authority === "code") {
          response[category] = values.map((label, sortOrder) => ({
            id: `${category}-${normalizeDictionaryKey(String(label))}`,
            category,
            key: normalizeDictionaryKey(String(label)),
            label: String(label),
            sortOrder,
            isActive: true,
          }));
        }
      }

      const durableCategories = Object.values(dictionaryPolicies)
        .filter((policy) => policy.authority === "postgres" && policy.publicExposed)
        .map((policy) => policy.category);
      const rows = await db.dictionary.findMany({
        where: { profile, category: { in: durableCategories }, isActive: true },
        orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { label: "asc" }, { key: "asc" }],
      });
      for (const category of durableCategories) response[category] = [];
      for (const row of rows) {
        response[row.category]!.push({
          id: row.id,
          category: row.category,
          key: row.key,
          label: row.label,
          sortOrder: row.sortOrder,
          isActive: true,
        });
      }
      return response;
    },

    async create(input, actor) {
      const policy = dictionaryPolicy(input.category);
      validatePolicyMutation(policy, "create");
      const key = validateText(input.key, "Key", policy.limits.key);
      const normalizedKey = normalizeDictionaryKey(key);
      if (!normalizedKey) throw new HttpError(400, "Key must contain at least one ASCII letter or number.");
      const label = validateText(input.label, "Label", policy.limits.label);
      const description = input.description == null ? null : input.description.trim();
      if (description && description.length > policy.limits.description) throw new HttpError(400, `Description must not exceed ${policy.limits.description} characters.`);
      const sortOrder = input.sortOrder ?? 0;
      if (!Number.isInteger(sortOrder) || Math.abs(sortOrder) > policy.limits.sortOrder) throw new HttpError(400, "Sort order is outside the supported range.");
      try {
        return await mutation(async (tx) => {
          await fail("beforeMutation");
          const record = await tx.dictionary.create({
            data: {
              profile,
              category: input.category,
              key: normalizedKey,
              normalizedKey,
              label,
              description,
              sortOrder,
              sourceType: "ADMIN",
            },
          });
          await fail("afterMutationBeforeAudit");
          await audit(tx, actor, record, "create", null);
          await fail("beforeCommit");
          return withPolicy(record);
        });
      } catch (error) {
        if (isUniqueConflict(error)) throw new HttpError(409, "A dictionary value with the same semantic key already exists in this category.");
        if (isSerializableConflict(error)) throw new HttpError(409, "Dictionary configuration changed concurrently. Refresh and try again.");
        throw error;
      }
    },

    async update(id, input, actor) {
      try {
        return await mutation(async (tx) => {
          const { record: before, policy } = await findMutable(tx, id);
          validatePolicyMutation(policy, "update");
          const data: Prisma.DictionaryUpdateManyMutationInput = { version: { increment: 1 } };
          if (input.label !== undefined) {
            if (!policy.allowLabelEdit) throw new HttpError(409, "Labels are protected for this category.");
            data.label = validateText(input.label, "Label", policy.limits.label);
          }
          if (input.description !== undefined) {
            if (!policy.allowDescriptionEdit) throw new HttpError(409, "Descriptions are protected for this category.");
            const description = input.description?.trim() || null;
            if (description && description.length > policy.limits.description) throw new HttpError(400, `Description must not exceed ${policy.limits.description} characters.`);
            data.description = description;
          }
          if (input.sortOrder !== undefined) {
            if (!policy.allowReorder) throw new HttpError(409, "Ordering is protected for this category.");
            if (!Number.isInteger(input.sortOrder) || Math.abs(input.sortOrder) > policy.limits.sortOrder) throw new HttpError(400, "Sort order is outside the supported range.");
            data.sortOrder = input.sortOrder;
          }
          await fail("beforeMutation");
          const changed = await tx.dictionary.updateMany({
            where: { id, profile, version: input.expectedVersion },
            data,
          });
          if (changed.count !== 1) throw new HttpError(409, "Dictionary value changed since it was loaded. Refresh and try again.");
          const after = await tx.dictionary.findUniqueOrThrow({ where: { id } });
          await fail("afterMutationBeforeAudit");
          await audit(tx, actor, after, "update", before.version);
          await fail("beforeCommit");
          return withPolicy(after);
        });
      } catch (error) {
        if (isSerializableConflict(error)) throw new HttpError(409, "Dictionary configuration changed concurrently. Refresh and try again.");
        throw error;
      }
    },

    async setActive(id, input, actor) {
      try {
        return await mutation(async (tx) => {
          const { record: before, policy } = await findMutable(tx, id);
          const operation = input.active ? "reactivate" : "deactivate";
          validatePolicyMutation(policy, operation);
          await fail("beforeMutation");
          const changed = await tx.dictionary.updateMany({
            where: { id, profile, version: input.expectedVersion },
            data: { isActive: input.active, version: { increment: 1 } },
          });
          if (changed.count !== 1) throw new HttpError(409, "Dictionary value changed since it was loaded. Refresh and try again.");
          const after = await tx.dictionary.findUniqueOrThrow({ where: { id } });
          await fail("afterMutationBeforeAudit");
          await audit(tx, actor, after, operation, before.version);
          await fail("beforeCommit");
          return withPolicy(after);
        });
      } catch (error) {
        if (isSerializableConflict(error)) throw new HttpError(409, "Dictionary configuration changed concurrently. Refresh and try again.");
        throw error;
      }
    },

    async assertActiveLabel(category, label) {
      const policy = dictionaryPolicy(category);
      if (policy.authority !== "postgres") throw new Error(`Category '${category}' is not governed by durable runtime validation.`);
      const found = await db.dictionary.findFirst({
        where: { profile, category, label: label.trim(), isActive: true },
        select: { id: true },
      });
      if (!found) throw new HttpError(400, `'${label}' is not an active ${category} value.`);
    },
  };
}

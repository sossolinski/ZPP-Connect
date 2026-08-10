import { HttpError } from "../../errors.js";
import { permissionScope } from "../../scope-policy.js";
import type { DirectoryActor as LegacyDirectoryActor } from "../../member-directory.js";
import type { IncidentAccessService } from "../incident-access/incident-access-service.js";
import type { FoundationRosteringRepository } from "./rostering-repository.js";
import type {
  AvailabilityAccess,
  AvailabilityCommandInput,
  AvailabilityQuery,
  AvailabilityRecord,
  CreateAvailabilityInput,
  CreateRosterShiftInput,
  RosterAccess,
  RosterCommandInput,
  RosterPermissions,
  RosterQuery,
  RosterShiftRecord,
  RosterStatus,
  RosteringActor,
  UpdateAvailabilityInput,
  UpdateRosterShiftInput,
} from "./rostering-types.js";

const staleMessage = "This roster shift changed while you were working. Refresh the current version before trying again";
const availabilityStaleMessage = "This availability record changed while you were working. Refresh the current version before trying again";

function scope(actor: RosteringActor, permission: string) {
  return permissionScope(actor as LegacyDirectoryActor, permission);
}

function rosterAccess(actor: RosteringActor, permission: string, ownMemberProfileId?: string | null): RosterAccess {
  const value = scope(actor, permission);
  return { global: value.allowed && value.global, groupIds: value.allowed ? [...value.groupIds] : [], ownMemberProfileId };
}

function availabilityAccess(actor: RosteringActor, permission: string, ownMemberProfileId?: string | null): AvailabilityAccess {
  const value = scope(actor, permission);
  return { global: value.allowed && value.global, groupIds: value.allowed ? [...value.groupIds] : [], ownMemberProfileId };
}

function scopeAllowsShift(actor: RosteringActor, permission: string, shift: RosterShiftRecord) {
  const value = scope(actor, permission);
  return value.allowed && (value.global || Boolean(shift.groupId && value.groupIds.has(shift.groupId)));
}

function resolved<T>(result: { record: T | null; conflict: boolean; idempotent?: boolean }, missing: string, conflictMessage: string) {
  if (result.conflict) throw new HttpError(409, conflictMessage);
  if (!result.record) throw new HttpError(404, missing);
  return { ...result.record, ...(result.idempotent ? { idempotent: true } : {}) };
}

export function createRosteringService(repository: FoundationRosteringRepository, incidentAccess: IncidentAccessService) {
  async function incident(actor: RosteringActor, incidentId: string, writable = false) {
    const context = await incidentAccess.authorize(actor, incidentId);
    if (writable && !context.writable) throw new HttpError(409, "Rostering in a closed incident is read-only");
    return context;
  }

  async function linkedMember(actor: RosteringActor) {
    return repository.resolveMemberForUser(actor);
  }

  async function readAccess(actor: RosteringActor, mine = false) {
    const member = await linkedMember(actor);
    const all = scope(actor, "roster:read");
    const own = actor.permissions.includes("roster:read-own") ? member?.id ?? null : null;
    if ((!all.allowed || mine) && !own) throw new HttpError(403, "Forbidden");
    return {
      member,
      access: {
        global: !mine && all.allowed && all.global,
        groupIds: !mine && all.allowed ? [...all.groupIds] : [],
        ownMemberProfileId: own,
      } satisfies RosterAccess,
    };
  }

  function decorate(shift: RosterShiftRecord, actor: RosteringActor, memberId?: string | null): RosterShiftRecord {
    const own = Boolean(memberId && shift.assignedMemberProfileId === memberId);
    const transitions: Record<RosterStatus, RosterStatus[]> = {
      Draft: ["Published", "Cancelled"],
      Published: ["Confirmed", "Declined", "Cancelled"],
      Confirmed: ["Cancelled", "Completed"],
      Declined: ["Cancelled"],
      Cancelled: [],
      Completed: [],
    };
    const allows = (target: RosterStatus) => transitions[shift.status].includes(target);
    const permissions: RosterPermissions = {
      canUpdate: !["Cancelled", "Completed"].includes(shift.status) && scopeAllowsShift(actor, "roster:update", shift),
      canPublish: allows("Published") && scopeAllowsShift(actor, "roster:publish", shift),
      canCancel: allows("Cancelled") && scopeAllowsShift(actor, "roster:cancel", shift),
      canComplete: allows("Completed") && scopeAllowsShift(actor, "roster:complete", shift),
      canConfirm: allows("Confirmed") && (scopeAllowsShift(actor, "roster:update", shift) || (own && actor.permissions.includes("roster:confirm-own"))),
      canDecline: allows("Declined") && (scopeAllowsShift(actor, "roster:update", shift) || (own && actor.permissions.includes("roster:decline-own"))),
    };
    return { ...shift, permissions };
  }

  async function managerShift(actor: RosteringActor, incidentId: string, id: string, permission: string) {
    const context = await incident(actor, incidentId, true);
    const access = rosterAccess(actor, permission);
    if (!access.global && access.groupIds.length === 0) throw new HttpError(403, "Forbidden");
    const shift = await repository.getShift(context, id, access, actor);
    if (!shift) throw new HttpError(404, "Roster shift not found");
    if (!scopeAllowsShift(actor, permission, shift)) throw new HttpError(403, "Forbidden");
    return { context, shift };
  }

  async function availabilityReadAccess(actor: RosteringActor, mine = false) {
    const member = await linkedMember(actor);
    const all = scope(actor, "availability:read-all");
    const own = actor.permissions.includes("availability:read-own") ? member?.id ?? null : null;
    if ((!all.allowed || mine) && !own) throw new HttpError(403, "Forbidden");
    return {
      member,
      access: {
        global: !mine && all.allowed && all.global,
        groupIds: !mine && all.allowed ? [...all.groupIds] : [],
        ownMemberProfileId: own,
      } satisfies AvailabilityAccess,
    };
  }

  async function mutableAvailabilityMember(actor: RosteringActor, requested?: string) {
    const manage = scope(actor, "availability:manage-all");
    if (manage.allowed) {
      if (!requested) throw new HttpError(400, "Member profile is required");
      return { memberProfileId: requested, access: availabilityAccess(actor, "availability:manage-all") };
    }
    if (!actor.permissions.includes("availability:update-own")) throw new HttpError(403, "Forbidden");
    const member = await linkedMember(actor);
    if (!member) throw new HttpError(409, "No linked member profile is available for this action");
    return { memberProfileId: member.id, access: availabilityAccess(actor, "availability:update-own", member.id) };
  }

  function decorateAvailability(record: AvailabilityRecord, access: AvailabilityAccess) {
    const canManage = access.global || access.groupIds.length > 0;
    const own = access.ownMemberProfileId === record.memberProfileId;
    return { ...record, permissions: { canUpdate: canManage || own, canRemove: canManage || own } };
  }

  return {
    kind: repository.kind,
    listShifts: async (actor: RosteringActor, incidentId: string, query: RosterQuery) => {
      const context = await incident(actor, incidentId);
      const { member, access } = await readAccess(actor, Boolean(query.mine));
      const result = await repository.listShifts(context, query, access, actor);
      return { ...result, linkedMemberProfile: member, data: result.data.map((shift) => decorate(shift, actor, member?.id)) };
    },
    getShift: async (actor: RosteringActor, incidentId: string, id: string) => {
      const context = await incident(actor, incidentId);
      const { member, access } = await readAccess(actor);
      const shift = await repository.getShift(context, id, access, actor);
      if (!shift) throw new HttpError(404, "Roster shift not found");
      return decorate(shift, actor, member?.id);
    },
    createShift: async (actor: RosteringActor, incidentId: string, input: CreateRosterShiftInput) => {
      const context = await incident(actor, incidentId, true);
      const createScope = scope(actor, "roster:create");
      if (!createScope.allowed || (!createScope.global && (!input.groupId || !createScope.groupIds.has(input.groupId)))) throw new HttpError(403, "A permitted group is required");
      return decorate(resolved(await repository.createShift(context, input, actor), "Roster shift not found", staleMessage), actor, (await linkedMember(actor))?.id);
    },
    updateShift: async (actor: RosteringActor, incidentId: string, id: string, input: UpdateRosterShiftInput, expectedVersion: number) => {
      const { context } = await managerShift(actor, incidentId, id, "roster:update");
      if (input.groupId) {
        const updateScope = scope(actor, "roster:update");
        if (!updateScope.global && !updateScope.groupIds.has(input.groupId)) throw new HttpError(403, "Forbidden");
      }
      return decorate(resolved(await repository.updateShift(context, id, input, expectedVersion, actor), "Roster shift not found", staleMessage), actor, (await linkedMember(actor))?.id);
    },
    transitionShift: async (actor: RosteringActor, incidentId: string, id: string, nextStatus: RosterStatus, input: RosterCommandInput) => {
      const permission = nextStatus === "Published" ? "roster:publish" : nextStatus === "Cancelled" ? "roster:cancel" : nextStatus === "Completed" ? "roster:complete" : "roster:update";
      const context = await incident(actor, incidentId, true);
      const member = await linkedMember(actor);
      const access = rosterAccess(actor, permission, member?.id);
      const shift = await repository.getShift(context, id, { ...access, ownMemberProfileId: member?.id }, actor);
      if (!shift) throw new HttpError(404, "Roster shift not found");
      const own = shift.assignedMemberProfileId === member?.id;
      const allowed = nextStatus === "Confirmed"
        ? scopeAllowsShift(actor, "roster:update", shift) || (own && actor.permissions.includes("roster:confirm-own"))
        : nextStatus === "Declined"
          ? scopeAllowsShift(actor, "roster:update", shift) || (own && actor.permissions.includes("roster:decline-own"))
          : scopeAllowsShift(actor, permission, shift);
      if (!allowed) throw new HttpError(403, "Forbidden");
      return decorate(resolved(await repository.transitionShift(context, id, nextStatus, input, actor), "Roster shift not found", staleMessage), actor, member?.id);
    },
    listAvailability: async (actor: RosteringActor, query: AvailabilityQuery) => {
      const { member, access } = await availabilityReadAccess(actor, Boolean(query.mine));
      if (query.memberProfileId && !access.global && query.memberProfileId !== access.ownMemberProfileId && access.groupIds.length === 0) throw new HttpError(403, "Forbidden");
      const result = await repository.listAvailability(query, access, actor);
      return { ...result, linkedMemberProfile: member, data: result.data.map((record) => decorateAvailability(record, access)) };
    },
    createAvailability: async (actor: RosteringActor, input: CreateAvailabilityInput) => {
      const target = await mutableAvailabilityMember(actor, input.memberProfileId);
      return decorateAvailability(resolved(await repository.createAvailability(input, target.memberProfileId, actor), "Availability record not found", availabilityStaleMessage), { ...target.access, ownMemberProfileId: target.memberProfileId });
    },
    updateAvailability: async (actor: RosteringActor, id: string, input: UpdateAvailabilityInput, expectedVersion: number) => {
      const member = await linkedMember(actor);
      const manage = availabilityAccess(actor, "availability:manage-all");
      const own = actor.permissions.includes("availability:update-own") ? member?.id ?? null : null;
      const access = { ...manage, ownMemberProfileId: own };
      const current = await repository.getAvailability(id, access, actor);
      if (!current) throw new HttpError(404, "Availability record not found");
      const target = await mutableAvailabilityMember(actor, input.memberProfileId ?? current.memberProfileId);
      if (!manage.global && manage.groupIds.length === 0 && current.memberProfileId !== own) throw new HttpError(403, "Forbidden");
      return decorateAvailability(resolved(await repository.updateAvailability(id, input, expectedVersion, target.memberProfileId, actor), "Availability record not found", availabilityStaleMessage), access);
    },
    removeAvailability: async (actor: RosteringActor, id: string, input: AvailabilityCommandInput) => {
      const member = await linkedMember(actor);
      const manage = availabilityAccess(actor, "availability:manage-all");
      const own = actor.permissions.includes("availability:update-own") ? member?.id ?? null : null;
      const access = { ...manage, ownMemberProfileId: own };
      const current = await repository.getAvailability(id, access, actor);
      if (!current) throw new HttpError(404, "Availability record not found");
      if (!manage.global && manage.groupIds.length === 0 && current.memberProfileId !== own) throw new HttpError(403, "Forbidden");
      return decorateAvailability(resolved(await repository.removeAvailability(id, input, actor), "Availability record not found", availabilityStaleMessage), access);
    },
    readinessAvailability: (memberProfileId: string, from: Date, to: Date) => repository.readinessAvailability(memberProfileId, from, to),
    readinessRoster: async (actor: RosteringActor, memberProfileId: string, from: Date, to: Date) => {
      const incidentIds = await incidentAccess.visibleIncidentIds(actor);
      return repository.readinessRoster(memberProfileId, from, to, incidentIds);
    },
  };
}

export type RosteringService = ReturnType<typeof createRosteringService>;

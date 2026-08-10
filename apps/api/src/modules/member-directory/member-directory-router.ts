import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../errors.js";
import { requirePermission } from "../../rbac.js";
import type { MemberDirectoryService } from "./member-directory-service.js";
import type { DirectoryActor, GroupRecord, MemberProfileRecord } from "./member-directory-types.js";

const id = z.string().trim().min(1).max(100);
const nullableText = (max: number) => z.preprocess((value) => value === "" ? null : value, z.string().trim().max(max).optional().nullable());
const memberPool = z.enum(["ZPP", "TEC"]);
const memberStatus = z.enum(["Active", "Inactive", "Archived"]);
const groupPool = z.enum(["ZPP", "TEC", "Mixed"]);
const groupStatus = z.enum(["Active", "Standby", "Draft", "Archived"]);
const paging = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
const memberQuery = z.object({
  search: z.string().trim().max(200).optional(),
  pool: memberPool.optional(),
  status: memberStatus.optional(),
  functionName: z.string().trim().max(200).optional(),
  groupId: id.optional(),
  sortBy: z.enum(["displayName", "memberId", "pool", "assignedFunction", "status", "updatedAt"]).default("displayName"),
  sortDirection: z.enum(["asc", "desc"]).default("asc"),
  ...paging,
}).strict();
const groupQuery = z.object({
  sessionId: id.optional(),
  search: z.string().trim().max(200).optional(),
  pool: groupPool.optional(),
  status: groupStatus.optional(),
  functionName: z.string().trim().max(200).optional(),
  sortBy: z.enum(["name", "operationalId", "pool", "functionName", "status", "updatedAt"]).default("name"),
  sortDirection: z.enum(["asc", "desc"]).default("asc"),
  ...paging,
}).strict();
const memberCreate = z.object({
  memberId: z.string().trim().min(1).max(100).optional(),
  linkedUserId: nullableText(100),
  firstName: z.string().trim().min(1).max(200),
  lastName: z.string().trim().min(1).max(200),
  pool: memberPool.default("ZPP"),
  role: z.string().trim().min(1).max(200).default("Member"),
  assignedFunction: z.string().trim().min(1).max(200).default("Unassigned"),
  contactEmail: nullableText(320),
  phone: nullableText(100),
  languages: z.array(z.string().trim().min(1).max(30)).max(30).default(["PL"]),
  status: z.enum(["Active", "Inactive"]).default("Active"),
}).strict();
const memberUpdate = memberCreate.partial().extend({ expectedVersion: z.coerce.number().int().min(1) }).strict();
const version = z.object({ expectedVersion: z.coerce.number().int().min(1) }).strict();
const groupCreate = z.object({
  sessionId: id,
  name: z.string().trim().min(1).max(300),
  pool: groupPool.default("ZPP"),
  functionName: z.string().trim().min(1).max(200).default("Operational Support"),
  status: z.enum(["Active", "Standby", "Draft"]).default("Active"),
  notes: nullableText(5_000),
  memberIds: z.array(id).max(500).default([]),
  leaderId: nullableText(100),
}).strict();
const groupUpdate = z.object({
  sessionId: id,
  expectedVersion: z.coerce.number().int().min(1),
  name: z.string().trim().min(1).max(300).optional(),
  pool: groupPool.optional(),
  functionName: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["Active", "Standby", "Draft"]).optional(),
  notes: nullableText(5_000),
}).strict();
const groupVersion = z.object({ sessionId: id, expectedVersion: z.coerce.number().int().min(1) }).strict();
const membership = groupVersion.extend({ memberProfileId: id, role: z.string().trim().min(1).max(100).default("Member") }).strict();
const membershipRole = groupVersion.extend({ role: z.string().trim().min(1).max(100) }).strict();
const leader = groupVersion.extend({ memberProfileId: id }).strict();

function actor(req: Request): DirectoryActor {
  if (!req.user) throw new Error("Authenticated actor is required");
  return {
    id: req.user.id,
    email: req.user.email,
    displayName: req.user.displayName,
    roles: req.user.roles,
    permissions: req.user.permissions,
    roleAssignments: req.user.roleAssignments,
    requestId: req.requestId,
  };
}

export function createMemberDirectoryRouter(service: MemberDirectoryService, compatibility: {
  onMembers?: (records: MemberProfileRecord[], offset: number) => void;
  onMemberChange?: (record: MemberProfileRecord) => void;
  onGroups?: (records: GroupRecord[], incidentId: string, offset: number) => void;
  onGroupChange?: (record: GroupRecord) => void;
} = {}) {
  const router = Router();

  router.get("/member-profiles", requirePermission("member:read"), asyncHandler(async (req, res) => {
    const query = memberQuery.parse(req.query);
    const result = await service.listMembers(actor(req), query);
    compatibility.onMembers?.(result.data, result.offset);
    res.json(result);
  }));
  router.get("/member-profile-user-links", requirePermission("member:link-user"), asyncHandler(async (req, res) => {
    const query = z.object({ search: z.string().trim().max(200).optional(), memberProfileId: id.optional(), ...paging }).strict().parse(req.query);
    res.json(await service.listEligibleUsers(query.search, query.memberProfileId, query.limit, query.offset));
  }));
  router.get("/member-profiles/:id", requirePermission("member:read"), asyncHandler(async (req, res) => {
    res.json(await service.getMember(actor(req), id.parse(req.params.id)));
  }));
  router.post("/member-profiles", requirePermission("member:create"), asyncHandler(async (req, res) => {
    const record = await service.createMember(actor(req), memberCreate.parse(req.body));
    compatibility.onMemberChange?.(record);
    res.status(201).json(record);
  }));
  router.patch("/member-profiles/:id", requirePermission("member:update"), asyncHandler(async (req, res) => {
    const { expectedVersion, ...input } = memberUpdate.parse(req.body);
    const record = await service.updateMember(actor(req), id.parse(req.params.id), input, expectedVersion);
    compatibility.onMemberChange?.(record);
    res.json(record);
  }));
  router.post("/member-profiles/:id/archive", requirePermission("member:archive"), asyncHandler(async (req, res) => {
    const input = version.parse(req.body);
    const record = await service.archiveMember(actor(req), id.parse(req.params.id), input.expectedVersion);
    compatibility.onMemberChange?.(record);
    res.json(record);
  }));
  router.post("/member-profiles/:id/restore", requirePermission("member:archive"), asyncHandler(async (req, res) => {
    const input = version.parse(req.body);
    const record = await service.restoreMember(actor(req), id.parse(req.params.id), input.expectedVersion);
    compatibility.onMemberChange?.(record);
    res.json(record);
  }));

  router.get("/groups", requirePermission("group:read"), asyncHandler(async (req, res) => {
    const { sessionId, ...query } = groupQuery.parse(req.query);
    const result = await service.listGroups(actor(req), sessionId, query);
    compatibility.onGroups?.(result.data, sessionId ?? "", result.offset);
    res.json(result);
  }));
  router.post("/groups", requirePermission("group:create"), asyncHandler(async (req, res) => {
    const { sessionId, ...input } = groupCreate.parse(req.body);
    const record = await service.createGroup(actor(req), sessionId, input);
    compatibility.onGroupChange?.(record);
    res.status(201).json(record);
  }));
  router.get("/groups/:id/members", requirePermission("group:read"), asyncHandler(async (req, res) => {
    const query = z.object({ sessionId: id, ...paging }).strict().parse(req.query);
    res.json(await service.listGroupMembers(actor(req), query.sessionId, id.parse(req.params.id), query.limit, query.offset));
  }));
  router.post("/groups/:id/members", requirePermission("group:membership:manage"), asyncHandler(async (req, res) => {
    const input = membership.parse(req.body);
    const record = await service.addGroupMember(actor(req), input.sessionId, id.parse(req.params.id), input.memberProfileId, input.role, input.expectedVersion);
    compatibility.onGroupChange?.(record);
    res.status(201).json(record);
  }));
  router.patch("/groups/:id/members/:memberProfileId", requirePermission("group:membership:manage"), asyncHandler(async (req, res) => {
    const input = membershipRole.parse(req.body);
    const record = await service.changeGroupMemberRole(actor(req), input.sessionId, id.parse(req.params.id), id.parse(req.params.memberProfileId), input.role, input.expectedVersion);
    compatibility.onGroupChange?.(record);
    res.json(record);
  }));
  router.delete("/groups/:id/members/:memberProfileId", requirePermission("group:membership:manage"), asyncHandler(async (req, res) => {
    const input = groupVersion.parse(req.body);
    const record = await service.removeGroupMember(actor(req), input.sessionId, id.parse(req.params.id), id.parse(req.params.memberProfileId), input.expectedVersion);
    compatibility.onGroupChange?.(record);
    res.json(record);
  }));
  router.post("/groups/:id/set-leader", requirePermission("group:update"), asyncHandler(async (req, res) => {
    const input = leader.parse(req.body);
    const record = await service.setLeader(actor(req), input.sessionId, id.parse(req.params.id), input.memberProfileId, input.expectedVersion);
    compatibility.onGroupChange?.(record);
    res.json(record);
  }));
  router.get("/groups/:id", requirePermission("group:read"), asyncHandler(async (req, res) => {
    res.json(await service.getGroup(actor(req), id.parse(req.query.sessionId), id.parse(req.params.id)));
  }));
  router.patch("/groups/:id", requirePermission("group:update"), asyncHandler(async (req, res) => {
    const { sessionId, expectedVersion, ...input } = groupUpdate.parse(req.body);
    const record = await service.updateGroup(actor(req), sessionId, id.parse(req.params.id), input, expectedVersion);
    compatibility.onGroupChange?.(record);
    res.json(record);
  }));
  router.post("/groups/:id/archive", requirePermission("group:archive"), asyncHandler(async (req, res) => {
    const input = groupVersion.parse(req.body);
    const record = await service.archiveGroup(actor(req), input.sessionId, id.parse(req.params.id), input.expectedVersion);
    compatibility.onGroupChange?.(record);
    res.json(record);
  }));

  return router;
}

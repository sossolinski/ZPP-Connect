import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Archive,
  Ban,
  Building2,
  Database,
  KeyRound,
  Link2,
  MailPlus,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  ShieldOff,
  Unlink,
  UserCog,
  Users
} from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import type { AnyRecord, AppOrganization } from "../lib/types";
import { DialogSurface } from "../components/DialogSurface";
import { AlertBox, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Select, StatusBadge, Table, Textarea } from "../components/ui";

type AdminTab = "users" | "invitations" | "roles" | "organizations" | "dictionaries";
type LifecycleAction = "activate" | "suspend" | "archive" | "restore";

type LifecycleDialogState = {
  action: LifecycleAction;
  reason: string;
  impact: AnyRecord | null;
  loading: boolean;
  submitting: boolean;
  error: string;
};

type PolicyDialogState = {
  authenticationPolicy: string;
  reason: string;
  submitting: boolean;
  error: string;
};

type AdminPageProps = {
  initialTab?: AdminTab;
};

const tabs: Array<{ key: AdminTab; label: string; icon: typeof Users }> = [
  { key: "users", label: "Users & Access", icon: Users },
  { key: "invitations", label: "Invitations", icon: MailPlus },
  { key: "roles", label: "Roles & Permissions", icon: ShieldCheck },
  { key: "organizations", label: "Organizations", icon: Building2 },
  { key: "dictionaries", label: "Dictionaries", icon: Database }
];

const emptyUserDraft = {
  displayName: "",
  email: "",
  employeeId: "",
  department: "",
  organizationId: ""
};

const emptyRoleAssignmentDraft = {
  roleName: "",
  scopeType: "GLOBAL",
  scopeId: ""
};

function emptyInvitationRoleAssignmentDraft() {
  return {
    roleName: "",
    scopeType: "GLOBAL",
    scopeId: ""
  };
}

function emptyInvitationDraft() {
  return {
    displayName: "",
    email: "",
    employeeId: "",
    department: "",
    organizationId: "",
    authenticationPolicy: "SSO_OR_PASSWORD",
    memberProfileId: "",
    expiresAt: "",
    roleAssignments: [emptyInvitationRoleAssignmentDraft()]
  };
}

const emptyOverrideDraft = {
  permission: "",
  effect: "GRANT",
  reason: "",
  expiresAt: ""
};

const emptyCustomRoleDraft = {
  name: "",
  displayName: "",
  description: "",
  permissions: [] as string[]
};

const emptyOrganizationDraft = {
  key: "",
  name: "",
  type: "",
  status: "active",
  contactEmail: "",
  description: ""
};

function text(value: unknown, fallback = "Not recorded") {
  const rendered = String(value ?? "").trim();
  return rendered || fallback;
}

function formatDate(value: unknown) {
  const raw = String(value ?? "");
  if (!raw) return "Not recorded";
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return raw;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function toInputDateTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 16);
}

function roleName(role: AnyRecord) {
  return String(role.name ?? role.roleName ?? "");
}

function roleLabel(role: AnyRecord) {
  return String(role.displayName ?? role.roleDisplayName ?? role.name ?? role.roleName ?? "Role");
}

function roleByName(roles: AnyRecord[], name: string) {
  return roles.find((role) => roleName(role) === name);
}

function roleScopeTypes(role?: AnyRecord) {
  const values = Array.isArray(role?.scopeTypes) ? role.scopeTypes.map(String) : [];
  return values.length ? values : ["GLOBAL"];
}

function authenticationPolicyLabel(value: unknown) {
  const policy = String(value ?? "SSO_OR_PASSWORD");
  if (policy === "SSO_ONLY") return "Microsoft SSO";
  if (policy === "PASSWORD_ONLY") return "Email/password";
  return "Microsoft SSO or email/password";
}

function localOnboardingActionLabel(value: unknown) {
  const policy = String(value ?? "SSO_OR_PASSWORD");
  if (policy === "SSO_ONLY") return "Complete local SSO onboarding";
  if (policy === "PASSWORD_ONLY") return "Complete local password onboarding";
  return "Complete local onboarding";
}

function groupLabel(group?: AnyRecord | null) {
  if (!group) return "Select a group";
  return `${text(group.name, "Group")} · ${text(group.operationalId ?? group.id, "ID")}`;
}

function memberLabel(member?: AnyRecord | null) {
  if (!member) return "Select a member profile";
  return `${text(member.displayName ?? `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim(), "Member")} · ${text(member.memberId ?? member.operationalId ?? member.id, "ID")}`;
}

function organizationDraftFrom(organization?: AppOrganization): AnyRecord {
  return {
    ...emptyOrganizationDraft,
    key: organization?.key ?? "",
    name: organization?.name ?? "",
    type: organization?.type ?? "",
    status: organization?.status ?? "active",
    contactEmail: organization?.contactEmail ?? "",
    description: organization?.description ?? ""
  };
}

function userDraftFrom(user?: AnyRecord) {
  return {
    displayName: text(user?.displayName, ""),
    email: text(user?.email, ""),
    employeeId: text(user?.employeeId, ""),
    department: text(user?.department, ""),
    organizationId: text(user?.organizationId, "")
  };
}

function roleDraftFrom(role?: AnyRecord) {
  return {
    name: text(role?.name, ""),
    displayName: text(role?.displayName, ""),
    description: text(role?.description, ""),
    permissions: Array.isArray(role?.permissions) ? role.permissions.map(String) : []
  };
}

function permissionSearchText(row: AnyRecord) {
  return `${row.permission ?? row.id ?? ""} ${row.description ?? ""} ${row.decision ?? ""} ${row.source ?? ""}`.toLowerCase();
}

function lifecycleActionLabel(action: LifecycleAction) {
  if (action === "activate") return "Activate";
  if (action === "suspend") return "Suspend";
  if (action === "archive") return "Archive";
  return "Restore";
}

function lifecycleActionVerb(action: LifecycleAction) {
  if (action === "activate") return "activated";
  if (action === "suspend") return "suspended";
  if (action === "archive") return "archived";
  return "restored";
}

function lifecycleActionDescription(action: LifecycleAction) {
  if (action === "activate") return "Activate this pending account so it can be used when access requirements are met.";
  if (action === "suspend") return "Suspend sign-in access while keeping the account, roles, linked member profile and operational history in place.";
  if (action === "archive") return "Archive the account from normal use while preserving linked records and audit history.";
  return "Restore the account to its next valid status without changing linked records.";
}

function lifecycleEnabled(action: LifecycleAction, status: unknown) {
  const value = String(status ?? "");
  if (action === "activate") return value === "Pending";
  if (action === "suspend") return value === "Active";
  if (action === "archive") return value !== "Archived";
  return value === "Suspended" || value === "Archived";
}

function impactCount(value: unknown) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function invitationStatusLabel(value: unknown) {
  return text(value, "None");
}

export function AdminPage({ initialTab = "users" }: AdminPageProps) {
  const { user: currentUser } = useApp();
  const [activeTab, setActiveTab] = useState<AdminTab>(initialTab);
  const [users, setUsers] = useState<AnyRecord[]>([]);
  const [roles, setRoles] = useState<AnyRecord[]>([]);
  const [groups, setGroups] = useState<AnyRecord[]>([]);
  const [memberProfiles, setMemberProfiles] = useState<AnyRecord[]>([]);
  const [capabilities, setCapabilities] = useState<AnyRecord[]>([]);
  const [organizations, setOrganizations] = useState<AppOrganization[]>([]);
  const [dictionaries, setDictionaries] = useState<AnyRecord[]>([]);
  const [invitations, setInvitations] = useState<AnyRecord[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userFilters, setUserFilters] = useState({ search: "", status: "", role: "", linked: "", authenticationPolicy: "", invitationStatus: "", limit: 50, offset: 0 });
  const [invitationTotal, setInvitationTotal] = useState(0);
  const [invitationFilters, setInvitationFilters] = useState({ search: "", status: "", authenticationPolicy: "", limit: 50, offset: 0 });
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedUser, setSelectedUser] = useState<AnyRecord | null>(null);
  const [effectiveAccess, setEffectiveAccess] = useState<AnyRecord | null>(null);
  const [accessHistory, setAccessHistory] = useState<AnyRecord[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [selectedRole, setSelectedRole] = useState<AnyRecord | null>(null);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [userDraft, setUserDraft] = useState(emptyUserDraft);
  const [newUserDraft, setNewUserDraft] = useState(emptyUserDraft);
  const [roleAssignmentDraft, setRoleAssignmentDraft] = useState(emptyRoleAssignmentDraft);
  const [overrideDraft, setOverrideDraft] = useState(emptyOverrideDraft);
  const [memberLinkDraft, setMemberLinkDraft] = useState("");
  const [policyDraft, setPolicyDraft] = useState("SSO_OR_PASSWORD");
  const [lifecycleDialog, setLifecycleDialog] = useState<LifecycleDialogState | null>(null);
  const [policyDialog, setPolicyDialog] = useState<PolicyDialogState | null>(null);
  const [accessSearch, setAccessSearch] = useState("");
  const [newRoleDraft, setNewRoleDraft] = useState(emptyCustomRoleDraft);
  const [roleEditorDraft, setRoleEditorDraft] = useState(emptyCustomRoleDraft);
  const [organizationDraft, setOrganizationDraft] = useState<AnyRecord>(organizationDraftFrom());
  const [invitationDraft, setInvitationDraft] = useState<AnyRecord>(emptyInvitationDraft());
  const [invitationReviewOpen, setInvitationReviewOpen] = useState(false);
  const [revokeReasons, setRevokeReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingAction, setSavingAction] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const selectedOrganization = useMemo(
    () => organizations.find((organization) => organization.id === selectedOrganizationId),
    [organizations, selectedOrganizationId]
  );
  const selectedRoleDefinition = roleByName(roles, roleAssignmentDraft.roleName);
  const groupScopedRole = Boolean(selectedRoleDefinition?.scopeTypes?.includes("GROUP"));
  const activeUserRoles = Array.isArray(selectedUser?.roleAssignments) ? selectedUser.roleAssignments : [];
  const activeOverrides = [
    ...(Array.isArray(effectiveAccess?.activeGrants) ? effectiveAccess.activeGrants : []),
    ...(Array.isArray(effectiveAccess?.activeDenies) ? effectiveAccess.activeDenies : [])
  ];
  const filteredAccessRows = (Array.isArray(effectiveAccess?.data) ? effectiveAccess.data : []).filter((row: AnyRecord) =>
    !accessSearch.trim() || permissionSearchText(row).includes(accessSearch.trim().toLowerCase())
  );
  const canPrevious = userFilters.offset > 0;
  const canNext = userFilters.offset + userFilters.limit < userTotal;
  const canInvitationPrevious = invitationFilters.offset > 0;
  const canInvitationNext = invitationFilters.offset + invitationFilters.limit < invitationTotal;
  const editingSelf = Boolean(currentUser?.id && selectedUser?.id === currentUser.id);
  const showDevelopmentOnboarding = import.meta.env.DEV;
  const eligibleMemberProfiles = memberProfiles.filter((member) => !member.linkedUserId || String(member.id) === String(invitationDraft.memberProfileId));

  async function loadUsers(nextFilters = userFilters) {
    const response = await api.adminUsers(nextFilters);
    setUsers(response.data);
    setUserTotal(response.total ?? response.data.length);
    return response.data;
  }

  async function loadInvitations(nextFilters = invitationFilters) {
    const response = await api.adminInvitations(nextFilters);
    setInvitations(response.data);
    setInvitationTotal(response.total ?? response.data.length);
    return response.data;
  }

  async function refreshSelectedUser(userId = selectedUserId) {
    if (!userId) return;
    const [userDetail, accessDetail, history] = await Promise.all([
      api.adminUser(userId),
      api.adminUserEffectiveAccess(userId),
      api.adminUserAccessHistory(userId)
    ]);
    setSelectedUser(userDetail);
    setUserDraft(userDraftFrom(userDetail));
    setMemberLinkDraft(String(userDetail.linkedMemberProfileId ?? ""));
    setPolicyDraft(String(userDetail.authenticationPolicy ?? "SSO_OR_PASSWORD"));
    setEffectiveAccess(accessDetail);
    setAccessHistory(history.data ?? []);
  }

  async function loadAdmin() {
    setLoading(true);
    setError("");
    try {
      const [userList, invitationList, roleList, organizationList, dictionaryList, groupList, memberList, capabilityList] = await Promise.all([
        api.adminUsers(userFilters),
        api.adminInvitations(invitationFilters),
        api.adminRoles(),
        api.adminOrganizations(),
        api.adminDictionaries(),
        api.groups({ limit: 200 }),
        api.memberProfiles({ limit: 200 }),
        api.adminCapabilities()
      ]);
      setUsers(userList.data);
      setUserTotal(userList.total ?? userList.data.length);
      setInvitations(invitationList.data);
      setInvitationTotal(invitationList.total ?? invitationList.data.length);
      setRoles(roleList.data);
      setOrganizations(organizationList.data);
      setDictionaries(dictionaryList.data);
      setGroups(groupList.data);
      setMemberProfiles(memberList.data);
      setCapabilities(capabilityList.data);
      if (selectedUserId) await refreshSelectedUser(selectedUserId);
      if (selectedRoleId) {
        const role = await api.adminRole(selectedRoleId);
        setSelectedRole(role);
        setRoleEditorDraft(roleDraftFrom(role));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAdmin();
  }, []);

  function updateUserFilter(key: string, value: string) {
    setUserFilters((current) => ({ ...current, [key]: value, offset: 0 }));
  }

  async function applyUserFilters(event?: FormEvent) {
    event?.preventDefault();
    setSavingAction("filter-users");
    setError("");
    try {
      await loadUsers({ ...userFilters, offset: 0 });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  async function changeUserPage(delta: number) {
    const nextFilters = { ...userFilters, offset: Math.max(0, userFilters.offset + delta * userFilters.limit) };
    setUserFilters(nextFilters);
    setSavingAction("page-users");
    setError("");
    try {
      await loadUsers(nextFilters);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  async function selectUser(userId: string) {
    setSelectedUserId(userId);
    setNotice("");
    setError("");
    setSavingAction("select-user");
    try {
      await refreshSelectedUser(userId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  function updateDraft(setter: (value: any) => void, key: string, value: string) {
    setter((current: AnyRecord) => ({ ...current, [key]: value }));
  }

  async function runUserMutation(action: string, success: string, mutation: () => Promise<AnyRecord>) {
    setSavingAction(action);
    setError("");
    setNotice("");
    try {
      const result = await mutation();
      const nextUser = result.user ?? result;
      if (nextUser?.id) {
        setSelectedUserId(String(nextUser.id));
        await Promise.all([loadUsers(), loadInvitations(), refreshSelectedUser(String(nextUser.id))]);
      } else if (selectedUserId) {
        await Promise.all([loadUsers(), loadInvitations(), refreshSelectedUser(selectedUserId)]);
      } else {
        await Promise.all([loadUsers(), loadInvitations()]);
      }
      setNotice(success);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  async function createUser() {
    const payload = {
      displayName: newUserDraft.displayName.trim(),
      email: newUserDraft.email.trim(),
      employeeId: newUserDraft.employeeId.trim(),
      department: newUserDraft.department.trim(),
      organizationId: newUserDraft.organizationId || undefined
    };
    if (!payload.displayName || !payload.email) {
      setError("Name and login identifier are required.");
      return;
    }
    await runUserMutation("create-user", "Account created.", async () => {
      const created = await api.createAdminUser(payload);
      setNewUserDraft(emptyUserDraft);
      return created;
    });
  }

  async function saveUserMetadata() {
    if (!selectedUser) return;
    const payload = {
      ...userDraft,
      expectedVersion: selectedUser.version
    };
    await runUserMutation("save-user", "Account updated.", () => api.updateAdminUser(String(selectedUser.id), payload));
  }

  async function openLifecycleDialog(action: LifecycleAction) {
    if (!selectedUser) return;
    const userId = String(selectedUser.id);
    setNotice("");
    setError("");
    setLifecycleDialog({ action, reason: "", impact: null, loading: true, submitting: false, error: "" });
    try {
      const impact = await api.adminUserLifecycleImpact(userId);
      setLifecycleDialog((current) => current?.action === action ? { ...current, impact, loading: false } : current);
    } catch (err) {
      setLifecycleDialog((current) => current?.action === action ? { ...current, loading: false, error: (err as Error).message } : current);
    }
  }

  async function submitLifecycleAction() {
    if (!selectedUser || !lifecycleDialog) return;
    const action = lifecycleDialog.action;
    const reason = lifecycleDialog.reason.trim();
    const needsReason = action === "suspend" || action === "archive";
    if (needsReason && reason.length < 3) {
      setLifecycleDialog((current) => current ? { ...current, error: "A reason is required." } : current);
      return;
    }
    if (needsReason && lifecycleDialog.impact && lifecycleDialog.impact.available === false) {
      setLifecycleDialog((current) => current ? { ...current, error: "Account impact could not be reviewed. Refresh and try again." } : current);
      return;
    }
    const payload = { expectedVersion: selectedUser.version, reason };
    const calls = {
      activate: () => api.activateAdminUser(String(selectedUser.id), payload),
      suspend: () => api.suspendAdminUser(String(selectedUser.id), payload),
      archive: () => api.archiveAdminUser(String(selectedUser.id), payload),
      restore: () => api.restoreAdminUser(String(selectedUser.id), payload)
    };
    setLifecycleDialog((current) => current ? { ...current, submitting: true, error: "" } : current);
    setSavingAction(`lifecycle-${action}`);
    setError("");
    setNotice("");
    try {
      const result = await calls[action]();
      const nextUser = result.user ?? result;
      const nextId = String(nextUser?.id ?? selectedUser.id);
      setSelectedUserId(nextId);
      await Promise.all([loadUsers(), loadInvitations(), refreshSelectedUser(nextId)]);
      setLifecycleDialog(null);
      setNotice(`Account ${lifecycleActionVerb(action)}.`);
    } catch (err) {
      setLifecycleDialog((current) => current ? { ...current, submitting: false, error: (err as Error).message } : current);
    } finally {
      setSavingAction("");
    }
  }

  function openPolicyDialog() {
    if (!selectedUser) return;
    if (policyDraft === String(selectedUser.authenticationPolicy ?? "SSO_OR_PASSWORD")) {
      setError("Choose a different authentication policy.");
      return;
    }
    setNotice("");
    setError("");
    setPolicyDialog({ authenticationPolicy: policyDraft, reason: "", submitting: false, error: "" });
  }

  async function submitPolicyChange() {
    if (!selectedUser || !policyDialog) return;
    const reason = policyDialog.reason.trim();
    if (reason.length < 3) {
      setPolicyDialog((current) => current ? { ...current, error: "A reason is required." } : current);
      return;
    }
    setPolicyDialog((current) => current ? { ...current, submitting: true, error: "" } : current);
    setSavingAction("authentication-policy");
    setError("");
    setNotice("");
    try {
      const updated = await api.updateAdminUserAuthenticationPolicy(String(selectedUser.id), {
        authenticationPolicy: policyDialog.authenticationPolicy,
        reason,
        expectedVersion: selectedUser.version
      });
      const nextUser = updated.user ?? updated;
      const nextId = String(nextUser?.id ?? selectedUser.id);
      setSelectedUserId(nextId);
      await Promise.all([loadUsers(), loadInvitations(), refreshSelectedUser(nextId)]);
      setPolicyDialog(null);
      setNotice("Authentication policy updated.");
    } catch (err) {
      setPolicyDialog((current) => current ? { ...current, submitting: false, error: (err as Error).message } : current);
    } finally {
      setSavingAction("");
    }
  }

  async function addRoleAssignment() {
    if (!selectedUser) return;
    const payload = {
      roleName: roleAssignmentDraft.roleName,
      scopeType: roleAssignmentDraft.scopeType,
      scopeId: roleAssignmentDraft.scopeType === "GROUP" ? roleAssignmentDraft.scopeId : null
    };
    if (!payload.roleName) {
      setError("Select a role before assigning access.");
      return;
    }
    await runUserMutation("add-role", "Role assigned.", () => api.addAdminUserRoleAssignment(String(selectedUser.id), payload));
    setRoleAssignmentDraft(emptyRoleAssignmentDraft);
  }

  async function revokeRoleAssignment(assignment: AnyRecord) {
    if (!selectedUser) return;
    if (!window.confirm(`Revoke ${assignment.roleDisplayName ?? assignment.roleName} for ${selectedUser.displayName}?`)) return;
    await runUserMutation("revoke-role", "Role assignment revoked.", () =>
      api.revokeAdminUserRoleAssignment(String(selectedUser.id), String(assignment.id))
    );
  }

  async function addOverride() {
    if (!selectedUser) return;
    const payload = {
      permission: overrideDraft.permission,
      effect: overrideDraft.effect,
      reason: overrideDraft.reason.trim(),
      expiresAt: overrideDraft.expiresAt ? new Date(overrideDraft.expiresAt).toISOString() : null
    };
    if (!payload.permission || payload.reason.length < 3) {
      setError("Select a capability and provide a reason.");
      return;
    }
    await runUserMutation("add-override", payload.effect === "DENY" ? "Deny added." : "Grant added.", () =>
      api.addAdminUserCapabilityOverride(String(selectedUser.id), payload)
    );
    setOverrideDraft(emptyOverrideDraft);
  }

  async function revokeOverride(override: AnyRecord) {
    if (!selectedUser) return;
    if (!window.confirm(`Revoke ${override.effect === "DENY" ? "deny" : "grant"} for ${override.permission}?`)) return;
    await runUserMutation("revoke-override", "Access exception revoked.", () =>
      api.revokeAdminUserCapabilityOverride(String(selectedUser.id), String(override.id))
    );
  }

  async function linkMemberProfile() {
    if (!selectedUser || !memberLinkDraft) return;
    await runUserMutation("link-member", "Member profile linked.", () =>
      api.linkAdminUserMemberProfile(String(selectedUser.id), { memberProfileId: memberLinkDraft })
    );
  }

  async function unlinkMemberProfile() {
    if (!selectedUser) return;
    if (!window.confirm(`Remove the member profile link for ${selectedUser.displayName}?`)) return;
    await runUserMutation("unlink-member", "Member profile unlinked.", () => api.unlinkAdminUserMemberProfile(String(selectedUser.id)));
    setMemberLinkDraft("");
  }

  function updateInvitationFilter(key: string, value: string) {
    setInvitationFilters((current) => ({ ...current, [key]: value, offset: 0 }));
  }

  async function applyInvitationFilters(event?: FormEvent) {
    event?.preventDefault();
    setSavingAction("filter-invitations");
    setError("");
    try {
      await loadInvitations({ ...invitationFilters, offset: 0 });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  async function changeInvitationPage(delta: number) {
    const nextFilters = { ...invitationFilters, offset: Math.max(0, invitationFilters.offset + delta * invitationFilters.limit) };
    setInvitationFilters(nextFilters);
    setSavingAction("page-invitations");
    setError("");
    try {
      await loadInvitations(nextFilters);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  function updateInvitationDraftField(key: string, value: string) {
    setInvitationDraft((current: AnyRecord) => ({ ...current, [key]: value }));
    setInvitationReviewOpen(false);
  }

  function updateInvitationRoleAssignment(index: number, key: string, value: string) {
    setInvitationDraft((current: AnyRecord) => {
      const roleAssignments = [...(Array.isArray(current.roleAssignments) ? current.roleAssignments : [])];
      const row = { ...emptyInvitationRoleAssignmentDraft(), ...(roleAssignments[index] ?? {}) };
      if (key === "roleName") {
        const role = roleByName(roles, value);
        const scopeTypes = roleScopeTypes(role);
        const scopeType = scopeTypes.includes(String(row.scopeType)) ? String(row.scopeType) : scopeTypes[0] ?? "GLOBAL";
        roleAssignments[index] = {
          ...row,
          roleName: value,
          scopeType,
          scopeId: scopeType === "GROUP" ? String(row.scopeId ?? "") : ""
        };
      } else if (key === "scopeType") {
        roleAssignments[index] = { ...row, scopeType: value, scopeId: value === "GROUP" ? String(row.scopeId ?? "") : "" };
      } else {
        roleAssignments[index] = { ...row, [key]: value };
      }
      return { ...current, roleAssignments };
    });
    setInvitationReviewOpen(false);
  }

  function addInvitationRoleAssignment() {
    setInvitationDraft((current: AnyRecord) => ({
      ...current,
      roleAssignments: [...(Array.isArray(current.roleAssignments) ? current.roleAssignments : []), emptyInvitationRoleAssignmentDraft()]
    }));
    setInvitationReviewOpen(false);
  }

  function removeInvitationRoleAssignment(index: number) {
    setInvitationDraft((current: AnyRecord) => {
      const roleAssignments = (Array.isArray(current.roleAssignments) ? current.roleAssignments : []).filter((_, rowIndex) => rowIndex !== index);
      return { ...current, roleAssignments: roleAssignments.length ? roleAssignments : [emptyInvitationRoleAssignmentDraft()] };
    });
    setInvitationReviewOpen(false);
  }

  function invitationValidationError() {
    const displayName = String(invitationDraft.displayName ?? "").trim();
    const email = String(invitationDraft.email ?? "").trim();
    if (!displayName || !email) return "Name and login identifier are required.";
    const roleAssignments = Array.isArray(invitationDraft.roleAssignments) ? invitationDraft.roleAssignments : [];
    if (!roleAssignments.length) return "Select at least one role for this invitation.";
    const seen = new Set<string>();
    for (const assignment of roleAssignments) {
      const role = roleByName(roles, String(assignment.roleName ?? ""));
      if (!role) return "Select a valid role for each assignment.";
      const scopeType = String(assignment.scopeType ?? "GLOBAL");
      const scopeTypes = roleScopeTypes(role);
      if (!scopeTypes.includes(scopeType)) return `${roleLabel(role)} cannot use that scope.`;
      const scopeId = String(assignment.scopeId ?? "").trim();
      if (scopeType === "GROUP" && !scopeId) return "Select an operational group for each group-scoped role.";
      const key = `${roleName(role)}:${scopeType}:${scopeType === "GROUP" ? scopeId : ""}`;
      if (seen.has(key)) return "Remove duplicate role assignments before creating the invitation.";
      seen.add(key);
    }
    return "";
  }

  function invitationPayload() {
    return {
      displayName: String(invitationDraft.displayName ?? "").trim(),
      email: String(invitationDraft.email ?? "").trim(),
      employeeId: String(invitationDraft.employeeId ?? "").trim(),
      department: String(invitationDraft.department ?? "").trim(),
      organizationId: String(invitationDraft.organizationId ?? "") || undefined,
      authenticationPolicy: String(invitationDraft.authenticationPolicy ?? "SSO_OR_PASSWORD"),
      memberProfileId: String(invitationDraft.memberProfileId ?? "") || undefined,
      expiresAt: invitationDraft.expiresAt ? new Date(String(invitationDraft.expiresAt)).toISOString() : undefined,
      roleAssignments: (Array.isArray(invitationDraft.roleAssignments) ? invitationDraft.roleAssignments : []).map((assignment: AnyRecord) => ({
        roleName: String(assignment.roleName ?? ""),
        scopeType: String(assignment.scopeType ?? "GLOBAL"),
        scopeId: String(assignment.scopeType ?? "GLOBAL") === "GROUP" ? String(assignment.scopeId ?? "") : null
      }))
    };
  }

  function reviewInvitation() {
    const message = invitationValidationError();
    if (message) {
      setError(message);
      setNotice("");
      setInvitationReviewOpen(false);
      return;
    }
    setError("");
    setNotice("");
    setInvitationReviewOpen(true);
  }

  async function createInvitation() {
    const message = invitationValidationError();
    if (message) {
      setError(message);
      setNotice("");
      return;
    }
    setSavingAction("create-invitation");
    setError("");
    setNotice("");
    try {
      await api.createAdminInvitation(invitationPayload());
      setInvitationDraft(emptyInvitationDraft());
      setInvitationReviewOpen(false);
      await Promise.all([loadUsers(), loadInvitations()]);
      setNotice("Invitation prepared.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  async function regenerateInvitation(invitation: AnyRecord) {
    setSavingAction(`regenerate-${invitation.id}`);
    setError("");
    setNotice("");
    try {
      await api.regenerateAdminInvitation(String(invitation.id));
      await Promise.all([loadInvitations(), loadUsers(), selectedUserId ? refreshSelectedUser(selectedUserId) : Promise.resolve()]);
      setNotice("Invitation regenerated.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  async function revokeInvitation(invitation: AnyRecord) {
    const reason = String(revokeReasons[String(invitation.id)] ?? "").trim();
    if (reason.length < 3) {
      setError("A reason is required to revoke an invitation.");
      return;
    }
    setSavingAction(`revoke-${invitation.id}`);
    setError("");
    setNotice("");
    try {
      await api.revokeAdminInvitation(String(invitation.id), { reason });
      setRevokeReasons((current) => {
        const next = { ...current };
        delete next[String(invitation.id)];
        return next;
      });
      await Promise.all([loadInvitations(), loadUsers(), selectedUserId ? refreshSelectedUser(selectedUserId) : Promise.resolve()]);
      setNotice("Invitation revoked.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  async function acceptLocalInvitation(invitation: AnyRecord) {
    setSavingAction(`accept-${invitation.id}`);
    setError("");
    setNotice("");
    try {
      await api.acceptLocalAdminInvitation(String(invitation.id), { expectedGeneration: invitation.resendGeneration });
      await Promise.all([loadInvitations(), loadUsers(), selectedUserId ? refreshSelectedUser(selectedUserId) : Promise.resolve()]);
      setNotice("Onboarding completed.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  async function selectRole(roleId: string) {
    setSelectedRoleId(roleId);
    setError("");
    setNotice("");
    setSavingAction("select-role");
    try {
      const role = await api.adminRole(roleId);
      setSelectedRole(role);
      setRoleEditorDraft(roleDraftFrom(role));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  function togglePermissionForDraft(setter: (value: any) => void, permission: string) {
    setter((current: AnyRecord) => {
      const permissions = new Set(Array.isArray(current.permissions) ? current.permissions.map(String) : []);
      if (permissions.has(permission)) permissions.delete(permission);
      else permissions.add(permission);
      return { ...current, permissions: Array.from(permissions).sort() };
    });
  }

  async function createRole() {
    const payload = {
      name: newRoleDraft.name.trim(),
      displayName: newRoleDraft.displayName.trim(),
      description: newRoleDraft.description.trim(),
      permissions: newRoleDraft.permissions
    };
    if (!payload.displayName) {
      setError("Role name is required.");
      return;
    }
    setSavingAction("create-role");
    setError("");
    setNotice("");
    try {
      const created = await api.createAdminRole(payload);
      setNewRoleDraft(emptyCustomRoleDraft);
      setRoles((current) => [...current, created].sort((left, right) => roleLabel(left).localeCompare(roleLabel(right))));
      await selectRole(String(created.id));
      setNotice("Custom role created.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  async function saveRole() {
    if (!selectedRole) return;
    setSavingAction("save-role");
    setError("");
    setNotice("");
    try {
      const saved = await api.updateAdminRole(String(selectedRole.id), {
        ...roleEditorDraft,
        expectedVersion: selectedRole.version
      });
      setSelectedRole(saved);
      setRoleEditorDraft(roleDraftFrom(saved));
      const roleList = await api.adminRoles();
      setRoles(roleList.data);
      setNotice(saved.protected ? "Role description updated." : "Custom role updated.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  async function archiveRole() {
    if (!selectedRole) return;
    if (!window.confirm(`Archive ${selectedRole.displayName}?`)) return;
    setSavingAction("archive-role");
    setError("");
    setNotice("");
    try {
      const saved = await api.archiveAdminRole(String(selectedRole.id), { expectedVersion: selectedRole.version });
      setSelectedRole(saved);
      setRoleEditorDraft(roleDraftFrom(saved));
      const roleList = await api.adminRoles();
      setRoles(roleList.data);
      setNotice("Custom role archived.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  function selectOrganization(organization: AppOrganization) {
    setSelectedOrganizationId(organization.id);
    setOrganizationDraft(organizationDraftFrom(organization));
    setNotice("");
  }

  function newOrganization() {
    setSelectedOrganizationId("");
    setOrganizationDraft(organizationDraftFrom());
    setNotice("");
  }

  async function saveOrganization() {
    const payload = {
      key: String(organizationDraft.key ?? "").trim(),
      name: String(organizationDraft.name ?? "").trim(),
      type: String(organizationDraft.type ?? "").trim(),
      status: String(organizationDraft.status ?? "active"),
      contactEmail: String(organizationDraft.contactEmail ?? "").trim(),
      description: String(organizationDraft.description ?? "").trim()
    };
    if (!payload.key || !payload.name) {
      setError("Organization key and name are required.");
      return;
    }
    setSavingAction("save-organization");
    setError("");
    setNotice("");
    try {
      const saved = selectedOrganization
        ? await api.updateAdminOrganization(selectedOrganization.id, payload)
        : await api.createAdminOrganization(payload);
      setOrganizations((current) => {
        const exists = current.some((organization) => organization.id === saved.id);
        return exists ? current.map((organization) => (organization.id === saved.id ? saved : organization)) : [...current, saved];
      });
      setSelectedOrganizationId(saved.id);
      setOrganizationDraft(organizationDraftFrom(saved));
      setNotice("Organization saved.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingAction("");
    }
  }

  if (loading) return <Loading label="Loading administration" />;
  if (error && users.length === 0 && roles.length === 0) return <EmptyState title="Unable to load administration" detail={error} />;

  return (
    <div className="grid gap-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="scrollbar-soft flex gap-2 overflow-x-auto">
          {tabs.map((tab) => (
            <Button
              key={tab.key}
              type="button"
              variant={activeTab === tab.key ? "primary" : "secondary"}
              icon={tab.icon}
              onClick={() => {
                setActiveTab(tab.key);
                setNotice("");
                setError("");
              }}
              className="shrink-0"
            >
              {tab.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {notice ? <Badge tone="success">{notice}</Badge> : null}
          {error ? <Badge tone="danger">{error}</Badge> : null}
          <Button type="button" variant="ghost" icon={RefreshCw} onClick={loadAdmin} disabled={Boolean(savingAction)}>
            Refresh
          </Button>
        </div>
      </div>

      {activeTab === "users" ? (
        <div className="grid gap-5">
          <Card>
            <CardHeader title="Find accounts" description="Search accounts by person, login identifier or employee identifier before changing access." />
            <form className="grid gap-3 p-4" onSubmit={applyUserFilters}>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.4fr)_repeat(5,minmax(10rem,0.45fr))]">
                <Field label="Search">
                  <Input
                    value={userFilters.search}
                    placeholder="Name, email, employee ID"
                    onChange={(event) => updateUserFilter("search", event.target.value)}
                  />
                </Field>
                <Field label="Status">
                  <Select value={userFilters.status} onChange={(event) => updateUserFilter("status", event.target.value)}>
                    <option value="">All statuses</option>
                    <option value="Pending">Pending</option>
                    <option value="Active">Active</option>
                    <option value="Suspended">Suspended</option>
                    <option value="Archived">Archived</option>
                  </Select>
                </Field>
                <Field label="Role">
                  <Select value={userFilters.role} onChange={(event) => updateUserFilter("role", event.target.value)}>
                    <option value="">All roles</option>
                    {roles.map((role) => (
                      <option key={String(role.name)} value={String(role.name)}>
                        {roleLabel(role)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Member link">
                  <Select value={userFilters.linked} onChange={(event) => updateUserFilter("linked", event.target.value)}>
                    <option value="">All accounts</option>
                    <option value="linked">Linked</option>
                    <option value="unlinked">Unlinked</option>
                  </Select>
                </Field>
                <Field label="Authentication policy">
                  <Select value={userFilters.authenticationPolicy} onChange={(event) => updateUserFilter("authenticationPolicy", event.target.value)}>
                    <option value="">All policies</option>
                    <option value="SSO_ONLY">Microsoft SSO</option>
                    <option value="PASSWORD_ONLY">Email/password</option>
                    <option value="SSO_OR_PASSWORD">SSO or email/password</option>
                  </Select>
                </Field>
                <Field label="Invitation">
                  <Select value={userFilters.invitationStatus} onChange={(event) => updateUserFilter("invitationStatus", event.target.value)}>
                    <option value="">All invitations</option>
                    <option value="Pending">Pending</option>
                    <option value="Accepted">Accepted</option>
                    <option value="Expired">Expired</option>
                    <option value="Revoked">Revoked</option>
                    <option value="None">No invitation</option>
                  </Select>
                </Field>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-muted-foreground">
                  Showing {userTotal ? userFilters.offset + 1 : 0}-{Math.min(userFilters.offset + users.length, userTotal)} of {userTotal}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" disabled={!canPrevious || Boolean(savingAction)} onClick={() => void changeUserPage(-1)}>
                    Previous
                  </Button>
                  <Button type="button" variant="secondary" disabled={!canNext || Boolean(savingAction)} onClick={() => void changeUserPage(1)}>
                    Next
                  </Button>
                  <Button type="submit" variant="primary" icon={Search} disabled={Boolean(savingAction)}>
                    Apply filters
                  </Button>
                </div>
              </div>
            </form>
          </Card>

          <div className="grid gap-5">
            <div className="grid gap-5">
              <Card>
                <CardHeader title="User accounts" description="Account status, assigned roles and member linkage are separate from operational group membership." />
                <div className="p-4">
                  <Table
                    columns={[
                      {
                        key: "displayName",
                        label: "Account",
                        className: "w-[260px]",
                        render: (row) => (
                          <div>
                            <p className="font-black text-foreground">{row.displayName}</p>
                            <p className="text-xs font-semibold text-muted-foreground">{row.email}</p>
                          </div>
                        )
                      },
                      {
                        key: "status",
                        label: "Status",
                        className: "w-[130px]",
                        render: (row) => (
                          <div className="flex flex-col items-start gap-1">
                            <StatusBadge value={row.status} />
                            <span className="text-xs font-semibold text-muted-foreground">{row.status}</span>
                          </div>
                        )
                      },
                      {
                        key: "authenticationPolicy",
                        label: "Access",
                        className: "w-[220px]",
                        render: (row) => (
                          <div className="flex flex-col items-start gap-1">
                            <Badge tone="info">{authenticationPolicyLabel(row.authenticationPolicy)}</Badge>
                            <span className="text-xs font-semibold text-muted-foreground">Invitation: {invitationStatusLabel(row.invitationStatus)}</span>
                          </div>
                        )
                      },
                      {
                        key: "roles",
                        label: "Roles",
                        className: "w-[320px]",
                        render: (row) => (
                          <div className="flex flex-wrap gap-1">
                            {(row.roleLabels ?? row.roles ?? []).map((role: string) => (
                              <Badge key={role} tone="info">{role}</Badge>
                            ))}
                          </div>
                        )
                      },
                      {
                        key: "linked",
                        label: "Member Profile",
                        className: "w-[220px]",
                        render: (row) => row.linkedMemberProfile ? memberLabel(row.linkedMemberProfile) : "Not linked"
                      },
                      {
                        key: "lastSuccessfulSignInAt",
                        label: "Last sign-in",
                        className: "w-[160px]",
                        render: (row) => formatDate(row.lastSuccessfulSignInAt)
                      }
                    ]}
                    rows={users}
                    actionWidth="w-28"
                    emptyTitle="No accounts found"
                    emptyDetail="Adjust the filters or create a new account."
                    rowAction={(row) => (
                      <Button
                        type="button"
                        size="sm"
                        variant={row.id === selectedUserId ? "primary" : "secondary"}
                        icon={UserCog}
                        onClick={() => void selectUser(String(row.id))}
                      >
                        Review
                      </Button>
                    )}
                  />
                </div>
              </Card>

              <Card>
                <CardHeader title="Create account" description="New accounts start as Pending until activated by an administrator." />
                <div className="grid gap-3 p-4 md:grid-cols-2">
                  <Field label="Display name" required>
                    <Input value={newUserDraft.displayName} onChange={(event) => updateDraft(setNewUserDraft, "displayName", event.target.value)} />
                  </Field>
                  <Field label="Login identifier" required>
                    <Input value={newUserDraft.email} onChange={(event) => updateDraft(setNewUserDraft, "email", event.target.value)} />
                  </Field>
                  <Field label="Employee ID">
                    <Input value={newUserDraft.employeeId} onChange={(event) => updateDraft(setNewUserDraft, "employeeId", event.target.value)} />
                  </Field>
                  <Field label="Department">
                    <Input value={newUserDraft.department} onChange={(event) => updateDraft(setNewUserDraft, "department", event.target.value)} />
                  </Field>
                  <Field label="Organization">
                    <Select value={newUserDraft.organizationId} onChange={(event) => updateDraft(setNewUserDraft, "organizationId", event.target.value)}>
                      <option value="">Default organization</option>
                      {organizations.map((organization) => (
                        <option key={organization.id} value={organization.id}>{organization.name}</option>
                      ))}
                    </Select>
                  </Field>
                  <div className="flex items-end">
                    <Button type="button" variant="create" icon={Plus} disabled={savingAction === "create-user"} onClick={() => void createUser()}>
                      {savingAction === "create-user" ? "Creating" : "Create account"}
                    </Button>
                  </div>
                </div>
              </Card>
            </div>

            <div className="grid content-start gap-5">
              {selectedUser ? (
                <>
                  <Card>
                    <CardHeader
                      title="Account"
                      description={`${selectedUser.displayName} · ${selectedUser.email}`}
                      action={<StatusBadge value={selectedUser.status} />}
                    />
                    <div className="grid gap-4 p-4">
                      {editingSelf ? (
                        <AlertBox>
                          You are editing your own account. Confirm another administrator can continue before removing administrative access.
                        </AlertBox>
                      ) : null}
                      {Array.isArray(effectiveAccess?.restrictions) && effectiveAccess.restrictions.length ? (
                        <AlertBox>{effectiveAccess.restrictions.join(" ")}</AlertBox>
                      ) : null}
                      <div className="grid gap-3 md:grid-cols-2">
                        <Field label="Display name" required>
                          <Input value={userDraft.displayName} onChange={(event) => updateDraft(setUserDraft, "displayName", event.target.value)} />
                        </Field>
                        <Field label="Login identifier" required>
                          <Input value={userDraft.email} onChange={(event) => updateDraft(setUserDraft, "email", event.target.value)} />
                        </Field>
                        <Field label="Employee ID">
                          <Input value={userDraft.employeeId} onChange={(event) => updateDraft(setUserDraft, "employeeId", event.target.value)} />
                        </Field>
                        <Field label="Department">
                          <Input value={userDraft.department} onChange={(event) => updateDraft(setUserDraft, "department", event.target.value)} />
                        </Field>
                      </div>
                      <div className="grid gap-2 rounded-md border border-border bg-muted p-3 text-sm font-semibold text-muted-foreground">
                        <div className="grid grid-cols-2 gap-2">
                          <span>Created: {formatDate(selectedUser.createdAt)}</span>
                          <span>Updated: {formatDate(selectedUser.updatedAt)}</span>
                          <span>Activated: {formatDate(selectedUser.activatedAt)}</span>
                          <span>Last sign-in: {formatDate(selectedUser.lastSuccessfulSignInAt)}</span>
                        </div>
                      </div>
                      <Button type="button" variant="primary" icon={Save} disabled={savingAction === "save-user"} onClick={() => void saveUserMetadata()}>
                        {savingAction === "save-user" ? "Saving" : "Save account"}
                      </Button>
                    </div>
                  </Card>

                  <Card>
                    <CardHeader title="Member Profile" description="The account link is separate from operational group membership." />
                    <div className="grid gap-3 p-4">
                      <div className="rounded-md border border-border bg-muted p-3 text-sm font-semibold">
                        <p className="text-muted-foreground">Current link</p>
                        <p className="mt-1 text-foreground">{selectedUser.linkedMemberProfile ? memberLabel(selectedUser.linkedMemberProfile) : "No member profile linked"}</p>
                      </div>
                      <Field label="Link to member profile">
                        <Select value={memberLinkDraft} onChange={(event) => setMemberLinkDraft(event.target.value)}>
                          <option value="">Select a member profile</option>
                          {memberProfiles.map((member) => (
                            <option key={String(member.id)} value={String(member.id)}>{memberLabel(member)}</option>
                          ))}
                        </Select>
                      </Field>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="secondary" icon={Link2} disabled={!memberLinkDraft || savingAction === "link-member"} onClick={() => void linkMemberProfile()}>
                          Link profile
                        </Button>
                        <Button type="button" variant="ghost" icon={Unlink} disabled={!selectedUser.linkedMemberProfileId || savingAction === "unlink-member"} onClick={() => void unlinkMemberProfile()}>
                          Remove link
                        </Button>
                      </div>
                    </div>
                  </Card>

                  <Card>
                    <CardHeader title="Roles" description="Global roles apply across the app. Group-scoped leader roles require a compatible operational group." />
                    <div className="grid gap-4 p-4">
                      <div className="grid gap-2">
                        {activeUserRoles.length ? activeUserRoles.map((assignment: AnyRecord) => (
                          <div key={String(assignment.id)} className="rounded-md border border-border bg-card p-3">
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                              <div>
                                <p className="font-black text-foreground">{assignment.roleDisplayName ?? assignment.roleName}</p>
                                <p className="text-sm font-semibold text-muted-foreground">
                                  {assignment.scopeType === "GROUP" ? `Group-scoped · ${assignment.scopeLabel}` : "Global role"}
                                </p>
                              </div>
                              <Button type="button" size="sm" variant="secondary" icon={ShieldOff} disabled={savingAction === "revoke-role"} onClick={() => void revokeRoleAssignment(assignment)}>
                                Revoke
                              </Button>
                            </div>
                          </div>
                        )) : <EmptyState title="No active roles" detail="Assign a role before this account can use protected modules." />}
                      </div>

                      <div className="grid gap-3 rounded-md border border-border bg-muted p-3">
                        <div className="grid gap-3 md:grid-cols-2">
                          <Field label="Role">
                            <Select
                              value={roleAssignmentDraft.roleName}
                              onChange={(event) => setRoleAssignmentDraft((current) => ({ ...current, roleName: event.target.value, scopeType: "GLOBAL", scopeId: "" }))}
                            >
                              <option value="">Select role</option>
                              {roles.filter((role) => role.status !== "Archived").map((role) => (
                                <option key={String(role.name)} value={String(role.name)}>{roleLabel(role)}</option>
                              ))}
                            </Select>
                          </Field>
                          <Field label="Scope">
                            <Select
                              value={roleAssignmentDraft.scopeType}
                              onChange={(event) => setRoleAssignmentDraft((current) => ({ ...current, scopeType: event.target.value, scopeId: event.target.value === "GROUP" ? current.scopeId : "" }))}
                            >
                              <option value="GLOBAL">Global</option>
                              <option value="GROUP">Group-scoped</option>
                            </Select>
                          </Field>
                          <Field label="Operational group">
                            <Select
                              value={roleAssignmentDraft.scopeId}
                              disabled={roleAssignmentDraft.scopeType !== "GROUP"}
                              onChange={(event) => setRoleAssignmentDraft((current) => ({ ...current, scopeId: event.target.value }))}
                            >
                              <option value="">{groupScopedRole ? "Select compatible group" : "Only for group-scoped roles"}</option>
                              {groups.map((group) => (
                                <option key={String(group.id)} value={String(group.id)}>{groupLabel(group)}</option>
                              ))}
                            </Select>
                          </Field>
                          <div className="flex items-end">
                            <Button type="button" variant="create" icon={Plus} disabled={savingAction === "add-role"} onClick={() => void addRoleAssignment()}>
                              Assign role
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </Card>

                  <Card>
                    <CardHeader title="Permission overrides" description="Use grants and denies only for explicit exceptions. Deny takes precedence." />
                    <div className="grid gap-4 p-4">
                      <div className="grid gap-2">
                        {activeOverrides.length ? activeOverrides.map((override: AnyRecord) => (
                          <div key={String(override.id)} className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <StatusBadge value={override.effect === "DENY" ? "Denied" : "Granted"} />
                                <p className="font-black text-foreground">{override.permission}</p>
                              </div>
                              <p className="mt-1 text-sm font-semibold text-muted-foreground">{text(override.reason, "No reason recorded")}</p>
                              <p className="text-xs font-semibold text-muted-foreground">Expires: {formatDate(override.expiresAt)}</p>
                            </div>
                            <Button type="button" size="sm" variant="secondary" icon={ShieldOff} disabled={savingAction === "revoke-override"} onClick={() => void revokeOverride(override)}>
                              Revoke
                            </Button>
                          </div>
                        )) : <EmptyState title="No active overrides" detail="Role assignments provide the normal access path." />}
                      </div>

                      <div className="grid gap-3 rounded-md border border-border bg-muted p-3">
                        <div className="grid gap-3 md:grid-cols-2">
                          <Field label="Capability">
                            <Select value={overrideDraft.permission} onChange={(event) => updateDraft(setOverrideDraft, "permission", event.target.value)}>
                              <option value="">Select capability</option>
                              {capabilities.map((capability) => (
                                <option key={String(capability.id)} value={String(capability.id)}>{capability.id}</option>
                              ))}
                            </Select>
                          </Field>
                          <Field label="Effect">
                            <Select value={overrideDraft.effect} onChange={(event) => updateDraft(setOverrideDraft, "effect", event.target.value)}>
                              <option value="GRANT">Grant</option>
                              <option value="DENY">Deny</option>
                            </Select>
                          </Field>
                          <Field label="Expiry">
                            <Input type="datetime-local" value={overrideDraft.expiresAt} onChange={(event) => updateDraft(setOverrideDraft, "expiresAt", event.target.value)} />
                          </Field>
                          <Field label="Reason" required>
                            <Input value={overrideDraft.reason} onChange={(event) => updateDraft(setOverrideDraft, "reason", event.target.value)} />
                          </Field>
                        </div>
                        <Button type="button" variant="create" icon={Plus} disabled={savingAction === "add-override"} onClick={() => void addOverride()}>
                          Add override
                        </Button>
                      </div>
                    </div>
                  </Card>

                  <Card>
                    <CardHeader title="Effective access" description="Final access is calculated by the server from roles, grants and denies." />
                    <div className="grid gap-3 p-4">
                      <Input value={accessSearch} placeholder="Search capability or source" onChange={(event) => setAccessSearch(event.target.value)} />
                      <Table
                        columns={[
                          { key: "permission", label: "Capability", className: "w-[220px]" },
                          { key: "decision", label: "Decision", className: "w-[120px]", render: (row) => <StatusBadge value={row.decision} /> },
                          { key: "source", label: "Source", className: "w-[140px]" },
                          { key: "description", label: "Description", className: "w-[360px]" }
                        ]}
                        rows={filteredAccessRows}
                        emptyTitle="No capabilities found"
                        emptyDetail="Try another search term."
                      />
                    </div>
                  </Card>

                  <Card>
                    <CardHeader
                      title="Authentication policy"
                      description="Controls which sign-in methods this account may use."
                      action={<Badge tone="info">{authenticationPolicyLabel(selectedUser.authenticationPolicy)}</Badge>}
                    />
                    <div className="grid gap-3 p-4">
                      <Field label="Authentication policy">
                        <Select value={policyDraft} onChange={(event) => setPolicyDraft(event.target.value)}>
                          <option value="SSO_ONLY">Microsoft SSO</option>
                          <option value="PASSWORD_ONLY">Email/password</option>
                          <option value="SSO_OR_PASSWORD">Microsoft SSO or email/password</option>
                        </Select>
                      </Field>
                      <div className="grid gap-2 rounded-md border border-border bg-muted p-3 text-sm font-semibold text-muted-foreground">
                        <span>Invitation: {invitationStatusLabel(selectedUser.invitationStatus)}</span>
                        <span>Current status: {text(selectedUser.status)}</span>
                      </div>
                      <Button
                        type="button"
                        variant="primary"
                        icon={KeyRound}
                        disabled={policyDraft === String(selectedUser.authenticationPolicy ?? "SSO_OR_PASSWORD") || savingAction === "authentication-policy"}
                        onClick={openPolicyDialog}
                      >
                        Review policy change
                      </Button>
                    </div>
                  </Card>

                  <Card>
                    <CardHeader title="Account lifecycle" description="Status actions change account access while preserving operational records and audit history." />
                    <div className="grid gap-3 p-4">
                      <div className="rounded-md border border-border bg-muted p-3 text-sm font-semibold text-muted-foreground">
                        Current status: <span className="text-foreground">{text(selectedUser.status)}</span>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Button type="button" variant="secondary" icon={RotateCcw} disabled={!lifecycleEnabled("activate", selectedUser.status) || savingAction === "lifecycle-activate"} onClick={() => void openLifecycleDialog("activate")}>
                          Activate
                        </Button>
                        <Button type="button" variant="warning" icon={Ban} disabled={!lifecycleEnabled("suspend", selectedUser.status) || editingSelf || savingAction === "lifecycle-suspend"} onClick={() => void openLifecycleDialog("suspend")}>
                          Suspend
                        </Button>
                        <Button type="button" variant="secondary" icon={RotateCcw} disabled={!lifecycleEnabled("restore", selectedUser.status) || savingAction === "lifecycle-restore"} onClick={() => void openLifecycleDialog("restore")}>
                          Restore
                        </Button>
                        <Button type="button" variant="danger" icon={Archive} disabled={!lifecycleEnabled("archive", selectedUser.status) || editingSelf || savingAction === "lifecycle-archive"} onClick={() => void openLifecycleDialog("archive")}>
                          Archive
                        </Button>
                      </div>
                    </div>
                  </Card>

                  <Card>
                    <CardHeader title="Access history" description="Security changes for this account." />
                    <div className="grid gap-2 p-4">
                      {accessHistory.length ? accessHistory.map((log) => (
                        <div key={String(log.id)} className="rounded-md border border-border bg-card p-3">
                          <p className="font-black text-foreground">{text(log.summary ?? log.action, "Access changed")}</p>
                          <p className="text-sm font-semibold text-muted-foreground">
                            {formatDate(log.createdAt)} · {text(log.actorDisplayName ?? log.actorEmail, "Unknown actor")}
                          </p>
                        </div>
                      )) : <EmptyState title="No access history" detail="Access changes for this account will appear here." />}
                    </div>
                  </Card>
                </>
              ) : (
                <Card>
                  <CardHeader title="Review an account" description="Select a user to inspect roles, access exceptions and history." />
                  <div className="p-4">
                    <EmptyState title="No account selected" detail="Choose Review in the user table." />
                  </div>
                </Card>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {activeTab === "invitations" ? (
        <div className="grid gap-5">
          <Card>
            <CardHeader title="Invite user" description="Prepare a pending account with the right access before onboarding is completed." />
            <div className="grid gap-4 p-4">
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Display name" required>
                  <Input value={invitationDraft.displayName} onChange={(event) => updateInvitationDraftField("displayName", event.target.value)} />
                </Field>
                <Field label="Login identifier" required>
                  <Input value={invitationDraft.email} onChange={(event) => updateInvitationDraftField("email", event.target.value)} />
                </Field>
                <Field label="Authentication policy" required>
                  <Select value={invitationDraft.authenticationPolicy} onChange={(event) => updateInvitationDraftField("authenticationPolicy", event.target.value)}>
                    <option value="SSO_OR_PASSWORD">Microsoft SSO or email/password</option>
                    <option value="SSO_ONLY">Microsoft SSO</option>
                    <option value="PASSWORD_ONLY">Email/password</option>
                  </Select>
                </Field>
                <Field label="Invitation expiry">
                  <Input type="datetime-local" value={invitationDraft.expiresAt} onChange={(event) => updateInvitationDraftField("expiresAt", event.target.value)} />
                </Field>
                <Field label="Employee ID">
                  <Input value={invitationDraft.employeeId} onChange={(event) => updateInvitationDraftField("employeeId", event.target.value)} />
                </Field>
                <Field label="Department">
                  <Input value={invitationDraft.department} onChange={(event) => updateInvitationDraftField("department", event.target.value)} />
                </Field>
                <Field label="Organization">
                  <Select value={invitationDraft.organizationId} onChange={(event) => updateInvitationDraftField("organizationId", event.target.value)}>
                    <option value="">Default organization</option>
                    {organizations.map((organization) => (
                      <option key={organization.id} value={organization.id}>{organization.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Member profile">
                  <Select value={invitationDraft.memberProfileId} onChange={(event) => updateInvitationDraftField("memberProfileId", event.target.value)}>
                    <option value="">No member profile link</option>
                    {eligibleMemberProfiles.map((member) => (
                      <option key={String(member.id)} value={String(member.id)}>{memberLabel(member)}</option>
                    ))}
                  </Select>
                </Field>
              </div>

              <div className="grid gap-3 rounded-md border border-border bg-muted p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-black text-foreground">Initial roles</p>
                    <p className="text-sm font-semibold text-muted-foreground">Roles are assigned to the user account, not to the invitation itself.</p>
                  </div>
                  <Button type="button" variant="secondary" icon={Plus} onClick={addInvitationRoleAssignment}>
                    Add role
                  </Button>
                </div>

                {(Array.isArray(invitationDraft.roleAssignments) ? invitationDraft.roleAssignments : []).map((assignment: AnyRecord, index: number) => {
                  const selectedRole = roleByName(roles, String(assignment.roleName ?? ""));
                  const scopeTypes = roleScopeTypes(selectedRole);
                  const canUseGroup = scopeTypes.includes("GROUP");
                  return (
                    <div key={index} className="grid gap-3 rounded-md border border-border bg-card p-3 lg:grid-cols-[minmax(0,1fr)_minmax(10rem,0.45fr)_minmax(0,1fr)_auto]">
                      <Field label="Role" required>
                        <Select value={String(assignment.roleName ?? "")} onChange={(event) => updateInvitationRoleAssignment(index, "roleName", event.target.value)}>
                          <option value="">Select role</option>
                          {roles.filter((role) => role.status !== "Archived").map((role) => (
                            <option key={String(role.name)} value={String(role.name)}>{roleLabel(role)}</option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Scope">
                        <Select
                          value={String(assignment.scopeType ?? "GLOBAL")}
                          onChange={(event) => updateInvitationRoleAssignment(index, "scopeType", event.target.value)}
                        >
                          {scopeTypes.includes("GLOBAL") ? <option value="GLOBAL">Global</option> : null}
                          {canUseGroup ? <option value="GROUP">Group-scoped</option> : null}
                        </Select>
                      </Field>
                      <Field label="Operational group">
                        <Select
                          value={String(assignment.scopeId ?? "")}
                          disabled={String(assignment.scopeType ?? "GLOBAL") !== "GROUP"}
                          onChange={(event) => updateInvitationRoleAssignment(index, "scopeId", event.target.value)}
                        >
                          <option value="">{String(assignment.scopeType ?? "GLOBAL") === "GROUP" ? "Select group" : "Only for group-scoped roles"}</option>
                          {groups.map((group) => (
                            <option key={String(group.id)} value={String(group.id)}>{groupLabel(group)}</option>
                          ))}
                        </Select>
                      </Field>
                      <div className="flex items-end">
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={(Array.isArray(invitationDraft.roleAssignments) ? invitationDraft.roleAssignments : []).length <= 1}
                          onClick={() => removeInvitationRoleAssignment(index)}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="primary" icon={ShieldCheck} onClick={reviewInvitation}>
                  Review invitation
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setInvitationDraft(emptyInvitationDraft());
                    setInvitationReviewOpen(false);
                  }}
                >
                  Clear
                </Button>
              </div>
            </div>
          </Card>

          {invitationReviewOpen ? (
            <Card>
              <CardHeader
                title="Review invitation"
                description={`${text(invitationDraft.displayName, "New user")} · ${text(invitationDraft.email, "login identifier")}`}
                action={<Badge tone="info">{authenticationPolicyLabel(invitationDraft.authenticationPolicy)}</Badge>}
              />
              <div className="grid gap-3 p-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-md border border-border bg-muted p-3">
                    <p className="text-xs font-black uppercase tracking-[0.12em] text-muted-foreground">Account status</p>
                    <p className="mt-1 font-black text-foreground">Pending</p>
                  </div>
                  <div className="rounded-md border border-border bg-muted p-3">
                    <p className="text-xs font-black uppercase tracking-[0.12em] text-muted-foreground">Member profile</p>
                    <p className="mt-1 font-black text-foreground">
                      {invitationDraft.memberProfileId ? memberLabel(memberProfiles.find((member) => String(member.id) === String(invitationDraft.memberProfileId))) : "No link"}
                    </p>
                  </div>
                  <div className="rounded-md border border-border bg-muted p-3">
                    <p className="text-xs font-black uppercase tracking-[0.12em] text-muted-foreground">Expires</p>
                    <p className="mt-1 font-black text-foreground">{invitationDraft.expiresAt ? formatDate(new Date(String(invitationDraft.expiresAt)).toISOString()) : "Default expiry"}</p>
                  </div>
                </div>
                <div className="rounded-md border border-border bg-card p-3">
                  <p className="font-black text-foreground">Roles to assign</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(Array.isArray(invitationDraft.roleAssignments) ? invitationDraft.roleAssignments : []).map((assignment: AnyRecord, index: number) => {
                      const role = roleByName(roles, String(assignment.roleName ?? ""));
                      const group = groups.find((item) => String(item.id) === String(assignment.scopeId ?? ""));
                      return (
                        <Badge key={`${assignment.roleName}-${index}`} tone="info">
                          {roleLabel(role ?? assignment)} · {assignment.scopeType === "GROUP" ? groupLabel(group) : "Global"}
                        </Badge>
                      );
                    })}
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button type="button" variant="create" icon={MailPlus} disabled={savingAction === "create-invitation"} onClick={() => void createInvitation()}>
                    {savingAction === "create-invitation" ? "Creating" : "Create invitation"}
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Invitations" description="Review pending onboarding work and account readiness." />
            <form className="grid gap-3 p-4" onSubmit={applyInvitationFilters}>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(11rem,0.3fr)_minmax(14rem,0.45fr)]">
                <Field label="Search">
                  <Input value={invitationFilters.search} placeholder="Name, login identifier, invitation ID" onChange={(event) => updateInvitationFilter("search", event.target.value)} />
                </Field>
                <Field label="Status">
                  <Select value={invitationFilters.status} onChange={(event) => updateInvitationFilter("status", event.target.value)}>
                    <option value="">All statuses</option>
                    <option value="Prepared">Prepared</option>
                    <option value="Sent">Sent</option>
                    <option value="Accepted">Accepted</option>
                    <option value="Expired">Expired</option>
                    <option value="Revoked">Revoked</option>
                  </Select>
                </Field>
                <Field label="Authentication policy">
                  <Select value={invitationFilters.authenticationPolicy} onChange={(event) => updateInvitationFilter("authenticationPolicy", event.target.value)}>
                    <option value="">All policies</option>
                    <option value="SSO_OR_PASSWORD">Microsoft SSO or email/password</option>
                    <option value="SSO_ONLY">Microsoft SSO</option>
                    <option value="PASSWORD_ONLY">Email/password</option>
                  </Select>
                </Field>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-muted-foreground">
                  Showing {invitationTotal ? invitationFilters.offset + 1 : 0}-{Math.min(invitationFilters.offset + invitations.length, invitationTotal)} of {invitationTotal}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" disabled={!canInvitationPrevious || Boolean(savingAction)} onClick={() => void changeInvitationPage(-1)}>
                    Previous
                  </Button>
                  <Button type="button" variant="secondary" disabled={!canInvitationNext || Boolean(savingAction)} onClick={() => void changeInvitationPage(1)}>
                    Next
                  </Button>
                  <Button type="submit" variant="primary" icon={Search} disabled={Boolean(savingAction)}>
                    Apply filters
                  </Button>
                </div>
              </div>
            </form>

            <div className="grid gap-3 border-t border-border p-4">
              {invitations.length ? invitations.map((invitation) => {
                const canRegenerate = ["Prepared", "Sent", "Expired"].includes(String(invitation.status));
                const canRevoke = ["Prepared", "Sent"].includes(String(invitation.status));
                const user = invitation.user ?? {};
                return (
                  <div key={String(invitation.id)} className="grid gap-3 rounded-md border border-border bg-card p-3">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-black text-foreground">{text(user.displayName, "Pending account")}</p>
                          <StatusBadge value={invitation.status} />
                          <Badge tone="info">{authenticationPolicyLabel(invitation.intendedAuthenticationPolicy)}</Badge>
                          {user.status ? <Badge tone="neutral">Account: {String(user.status)}</Badge> : null}
                        </div>
                        <p className="mt-1 text-sm font-semibold text-muted-foreground">{invitation.invitedEmailSnapshot}</p>
                        <p className="text-xs font-semibold text-muted-foreground">
                          Created {formatDate(invitation.createdAt)} by {text(invitation.createdBy?.displayName ?? invitation.createdBy?.email, "an administrator")} · Expires {formatDate(invitation.tokenExpiresAt)}
                        </p>
                        {invitation.memberProfile ? (
                          <p className="text-xs font-semibold text-muted-foreground">Member profile: {memberLabel(invitation.memberProfile)}</p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {canRegenerate ? (
                          <Button type="button" size="sm" variant="secondary" icon={RotateCcw} disabled={savingAction === `regenerate-${invitation.id}`} onClick={() => void regenerateInvitation(invitation)}>
                            Regenerate
                          </Button>
                        ) : null}
                        {showDevelopmentOnboarding && invitation.localOnboardingAvailable ? (
                          <Button type="button" size="sm" variant="create" icon={ShieldCheck} disabled={savingAction === `accept-${invitation.id}`} onClick={() => void acceptLocalInvitation(invitation)}>
                            {localOnboardingActionLabel(invitation.intendedAuthenticationPolicy)}
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {(Array.isArray(invitation.roleAssignments) ? invitation.roleAssignments : []).map((assignment: AnyRecord) => (
                        <Badge key={`${invitation.id}-${assignment.roleName}-${assignment.scopeId ?? "global"}`} tone="info">
                          {assignment.roleDisplayName ?? assignment.roleName} · {assignment.scopeType === "GROUP" ? assignment.scopeLabel : "Global"}
                        </Badge>
                      ))}
                    </div>

                    {canRevoke ? (
                      <div className="grid gap-2 rounded-md border border-border bg-muted p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                        <Field label="Revocation reason">
                          <Input
                            value={revokeReasons[String(invitation.id)] ?? ""}
                            placeholder="Reason for access history"
                            onChange={(event) => setRevokeReasons((current) => ({ ...current, [String(invitation.id)]: event.target.value }))}
                          />
                        </Field>
                        <Button type="button" variant="danger" icon={Ban} disabled={savingAction === `revoke-${invitation.id}`} onClick={() => void revokeInvitation(invitation)}>
                          Revoke invitation
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              }) : (
                <EmptyState title="No invitations found" detail="Adjust the filters or prepare a new invitation." />
              )}
            </div>
          </Card>
        </div>
      ) : null}

      {activeTab === "roles" ? (
        <div className="grid gap-5">
          <div className="grid gap-5">
            <Card>
              <CardHeader title="Role catalogue" description="Protected roles are fixed. Custom roles can use existing capabilities only." />
              <div className="p-4">
                <Table
                  columns={[
                    { key: "displayName", label: "Role", className: "w-[240px]", render: (row) => <span className="font-black">{roleLabel(row)}</span> },
                    { key: "status", label: "Status", className: "w-[120px]", render: (row) => <StatusBadge value={row.status} /> },
                    { key: "protected", label: "Type", className: "w-[140px]", render: (row) => <Badge tone={row.protected ? "info" : "neutral"}>{row.protected ? "Protected" : "Custom"}</Badge> },
                    { key: "capabilityCount", label: "Capabilities", className: "w-[120px]", render: (row) => <Badge>{row.capabilityCount ?? row.permissions?.length ?? 0}</Badge> },
                    { key: "assignedUserCount", label: "Assigned users", className: "w-[130px]", render: (row) => <Badge tone="info">{row.assignedUserCount ?? 0}</Badge> },
                    { key: "description", label: "Description", className: "w-[420px]" }
                  ]}
                  rows={roles}
                  actionWidth="w-28"
                  emptyTitle="No roles found"
                  emptyDetail="Protected roles should be available for administration."
                  rowAction={(row) => (
                    <Button type="button" size="sm" variant={row.id === selectedRoleId ? "primary" : "secondary"} icon={KeyRound} onClick={() => void selectRole(String(row.id))}>
                      Review
                    </Button>
                  )}
                />
              </div>
            </Card>

            <Card>
              <CardHeader title="Create custom role" description="Custom roles cannot introduce new capability keys." />
              <div className="grid gap-3 p-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Display name" required>
                    <Input value={newRoleDraft.displayName} onChange={(event) => updateDraft(setNewRoleDraft, "displayName", event.target.value)} />
                  </Field>
                  <Field label="Role key">
                    <Input value={newRoleDraft.name} onChange={(event) => updateDraft(setNewRoleDraft, "name", event.target.value)} />
                  </Field>
                </div>
                <Field label="Description">
                  <Textarea value={newRoleDraft.description} onChange={(event) => updateDraft(setNewRoleDraft, "description", event.target.value)} />
                </Field>
                <div className="grid max-h-64 gap-2 overflow-y-auto rounded-md border border-border bg-muted p-3 sm:grid-cols-2">
                  {capabilities.map((capability) => (
                    <label key={String(capability.id)} className="flex items-start gap-2 rounded-md border border-border bg-card p-2 text-sm font-semibold">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border-border text-[#145C63] focus:ring-ring"
                        checked={newRoleDraft.permissions.includes(String(capability.id))}
                        onChange={() => togglePermissionForDraft(setNewRoleDraft, String(capability.id))}
                      />
                      <span>
                        <span className="block font-black text-foreground">{capability.id}</span>
                        <span className="text-muted-foreground">{capability.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <Button type="button" variant="create" icon={Plus} disabled={savingAction === "create-role"} onClick={() => void createRole()}>
                  Create custom role
                </Button>
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader
              title={selectedRole ? roleLabel(selectedRole) : "Review a role"}
              description={selectedRole ? `${selectedRole.protected ? "Protected role" : "Custom role"} · ${selectedRole.assignedUserCount ?? 0} assigned users` : "Select a role from the catalogue."}
              action={selectedRole ? <StatusBadge value={selectedRole.status} /> : undefined}
            />
            <div className="grid gap-4 p-4">
              {selectedRole ? (
                <>
                  {selectedRole.protected ? (
                    <AlertBox tone="success">Protected role identifiers and capabilities are locked. Only the description can be adjusted here.</AlertBox>
                  ) : null}
                  <div className="grid gap-3">
                    <Field label="Display name" required>
                      <Input
                        value={roleEditorDraft.displayName}
                        readOnly={Boolean(selectedRole.protected)}
                        onChange={(event) => updateDraft(setRoleEditorDraft, "displayName", event.target.value)}
                      />
                    </Field>
                    <Field label="Role key">
                      <Input value={roleEditorDraft.name} readOnly onChange={(event) => updateDraft(setRoleEditorDraft, "name", event.target.value)} />
                    </Field>
                    <Field label="Description">
                      <Textarea value={roleEditorDraft.description} onChange={(event) => updateDraft(setRoleEditorDraft, "description", event.target.value)} />
                    </Field>
                  </div>
                  <div className="grid max-h-80 gap-2 overflow-y-auto rounded-md border border-border bg-muted p-3">
                    {capabilities.map((capability) => (
                      <label key={String(capability.id)} className="flex items-start gap-2 rounded-md border border-border bg-card p-2 text-sm font-semibold">
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4 rounded border-border text-[#145C63] focus:ring-ring disabled:opacity-50"
                          disabled={Boolean(selectedRole.protected)}
                          checked={roleEditorDraft.permissions.includes(String(capability.id))}
                          onChange={() => togglePermissionForDraft(setRoleEditorDraft, String(capability.id))}
                        />
                        <span>
                          <span className="block font-black text-foreground">{capability.id}</span>
                          <span className="text-muted-foreground">{capability.description}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="primary" icon={Save} disabled={savingAction === "save-role"} onClick={() => void saveRole()}>
                      Save role
                    </Button>
                    {!selectedRole.protected && selectedRole.status !== "Archived" ? (
                      <Button type="button" variant="danger" icon={Archive} disabled={savingAction === "archive-role"} onClick={() => void archiveRole()}>
                        Archive custom role
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : (
                <EmptyState title="No role selected" detail="Choose Review in the role catalogue." />
              )}
            </div>
          </Card>
        </div>
      ) : null}

      {activeTab === "organizations" ? (
        <div className="grid gap-5">
          <Card>
            <CardHeader
              title="Organizations"
              description="Operational organizations used by account records."
              action={<Button type="button" variant="create" icon={Plus} onClick={newOrganization}>New</Button>}
            />
            <div className="p-4">
              <Table
                columns={[
                  { key: "name", label: "Organization", className: "w-[240px]" },
                  { key: "key", label: "Key", className: "w-[120px]" },
                  { key: "type", label: "Type", className: "w-[160px]" },
                  { key: "status", label: "Status", className: "w-[120px]", render: (row) => <StatusBadge value={row.status} /> },
                  { key: "contactEmail", label: "Contact", className: "w-[220px]" },
                  { key: "description", label: "Description", className: "w-[420px]" }
                ]}
                rows={organizations}
                actionWidth="w-24"
                rowAction={(row) => (
                  <Button type="button" size="sm" variant={row.id === selectedOrganizationId ? "primary" : "secondary"} icon={Building2} onClick={() => selectOrganization(row as AppOrganization)}>
                    Edit
                  </Button>
                )}
              />
            </div>
          </Card>

          <Card>
            <CardHeader title={selectedOrganization ? "Edit Organization" : "New Organization"} description={selectedOrganization?.name ?? "Create an operational unit"} />
            <div className="grid gap-3 p-4">
              <Field label="Name" required>
                <Input value={organizationDraft.name ?? ""} onChange={(event) => updateDraft(setOrganizationDraft, "name", event.target.value)} />
              </Field>
              <Field label="Key" required>
                <Input value={organizationDraft.key ?? ""} onChange={(event) => updateDraft(setOrganizationDraft, "key", event.target.value)} />
              </Field>
              <Field label="Type">
                <Input value={organizationDraft.type ?? ""} onChange={(event) => updateDraft(setOrganizationDraft, "type", event.target.value)} />
              </Field>
              <Field label="Status">
                <Select value={organizationDraft.status ?? "active"} onChange={(event) => updateDraft(setOrganizationDraft, "status", event.target.value)}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </Select>
              </Field>
              <Field label="Contact">
                <Input value={organizationDraft.contactEmail ?? ""} onChange={(event) => updateDraft(setOrganizationDraft, "contactEmail", event.target.value)} />
              </Field>
              <Field label="Description">
                <Textarea value={organizationDraft.description ?? ""} onChange={(event) => updateDraft(setOrganizationDraft, "description", event.target.value)} />
              </Field>
              <Button type="button" variant="primary" icon={Save} disabled={savingAction === "save-organization"} onClick={() => void saveOrganization()}>
                Save organization
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {activeTab === "dictionaries" ? (
        <Card>
          <CardHeader title="Dictionaries" description="Reference values used by operational workflows." />
          <div className="p-4">
            <Table
              columns={[
                { key: "category", label: "Category", className: "w-[180px]" },
                { key: "key", label: "Key", className: "w-[220px]" },
                { key: "label", label: "Label", className: "w-[260px]" },
                { key: "isActive", label: "Active", className: "w-[112px]", render: (row) => <StatusBadge value={row.isActive ? "Active" : "Inactive"} /> }
              ]}
              rows={dictionaries}
            />
          </div>
        </Card>
      ) : null}

      {lifecycleDialog && selectedUser ? (
        <DialogSurface
          title={`${lifecycleActionLabel(lifecycleDialog.action)} account`}
          description={lifecycleActionDescription(lifecycleDialog.action)}
          onClose={() => setLifecycleDialog(null)}
          dirty={Boolean(lifecycleDialog.reason)}
          busy={lifecycleDialog.submitting}
          initialFocus="first-control"
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card text-foreground shadow-2xl"
        >
          {({ requestClose }) => (
            <form
              noValidate
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submitLifecycleAction();
              }}
            >
              <div className="flex items-start justify-between gap-4 border-b border-border bg-muted px-5 py-4">
                <div>
                  <h2 data-dialog-heading="true" tabIndex={-1} className="text-lg font-black text-foreground">
                    {lifecycleActionLabel(lifecycleDialog.action)} account
                  </h2>
                  <p className="mt-1 text-sm font-semibold text-muted-foreground">{selectedUser.displayName} · {selectedUser.email}</p>
                </div>
                <StatusBadge value={selectedUser.status} />
              </div>

              <div className="grid gap-4 px-5">
                <AlertBox tone={lifecycleDialog.action === "archive" || lifecycleDialog.action === "suspend" ? "warning" : "success"}>
                  {lifecycleActionDescription(lifecycleDialog.action)}
                </AlertBox>

                <div className="rounded-md border border-border bg-muted p-3">
                  <h3 className="font-black text-foreground">Impact preview</h3>
                  {lifecycleDialog.loading ? (
                    <div className="mt-3">
                      <Loading label="Reviewing account impact" />
                    </div>
                  ) : lifecycleDialog.impact ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <div className="rounded-md border border-border bg-card p-3">
                        <p className="text-xs font-black uppercase tracking-wider text-muted-foreground">Assignments</p>
                        <p className="mt-1 text-2xl font-black text-foreground">{impactCount(lifecycleDialog.impact.assignments?.active)}</p>
                        <p className="text-xs font-semibold text-muted-foreground">
                          {impactCount(lifecycleDialog.impact.assignments?.open)} open · {impactCount(lifecycleDialog.impact.assignments?.claimed)} claimed
                        </p>
                      </div>
                      <div className="rounded-md border border-border bg-card p-3">
                        <p className="text-xs font-black uppercase tracking-wider text-muted-foreground">Roster shifts</p>
                        <p className="mt-1 text-2xl font-black text-foreground">{impactCount(lifecycleDialog.impact.rosterShifts?.active)}</p>
                        <p className="text-xs font-semibold text-muted-foreground">Active linked shifts</p>
                      </div>
                      <div className="rounded-md border border-border bg-card p-3">
                        <p className="text-xs font-black uppercase tracking-wider text-muted-foreground">Groups</p>
                        <p className="mt-1 text-2xl font-black text-foreground">{impactCount(lifecycleDialog.impact.groups?.memberships)}</p>
                        <p className="text-xs font-semibold text-muted-foreground">
                          {impactCount(lifecycleDialog.impact.groups?.leaderships)} leaderships · {impactCount(lifecycleDialog.impact.groups?.scopedRoleAssignments)} scoped roles
                        </p>
                      </div>
                      <div className="rounded-md border border-border bg-card p-3">
                        <p className="text-xs font-black uppercase tracking-wider text-muted-foreground">Access records</p>
                        <p className="mt-1 text-2xl font-black text-foreground">{impactCount(lifecycleDialog.impact.access?.roleAssignments)}</p>
                        <p className="text-xs font-semibold text-muted-foreground">
                          {impactCount(lifecycleDialog.impact.access?.activeGrants)} grants · {impactCount(lifecycleDialog.impact.access?.activeDenies)} denies
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-2 text-sm font-semibold text-muted-foreground">Impact review is not available.</p>
                  )}
                </div>

                {lifecycleDialog.impact?.available === false ? (
                  <AlertBox tone="danger">Account impact could not be reviewed. Refresh and try again before changing access.</AlertBox>
                ) : (
                  <AlertBox tone="success">This action does not reassign work, remove roles, unlink the member profile or delete audit history.</AlertBox>
                )}

                <Field
                  label="Reason"
                  required={lifecycleDialog.action === "suspend" || lifecycleDialog.action === "archive"}
                  helperText={lifecycleDialog.action === "suspend" || lifecycleDialog.action === "archive" ? "Required for suspend and archive actions." : "Optional note for the access history."}
                  error={lifecycleDialog.error}
                >
                  <Textarea
                    data-dialog-initial-focus="true"
                    value={lifecycleDialog.reason}
                    onChange={(event) => setLifecycleDialog((current) => current ? { ...current, reason: event.target.value, error: "" } : current)}
                  />
                </Field>
              </div>

              <div className="flex flex-col-reverse gap-2 border-t border-border bg-muted px-5 py-4 sm:flex-row sm:justify-end">
                <Button type="button" variant="secondary" disabled={lifecycleDialog.submitting} onClick={() => requestClose()}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant={lifecycleDialog.action === "archive" ? "danger" : lifecycleDialog.action === "suspend" ? "warning" : "primary"}
                  icon={lifecycleDialog.action === "archive" ? Archive : lifecycleDialog.action === "suspend" ? Ban : RotateCcw}
                  disabled={lifecycleDialog.loading || lifecycleDialog.submitting || ((lifecycleDialog.action === "suspend" || lifecycleDialog.action === "archive") && lifecycleDialog.impact?.available === false)}
                >
                  {lifecycleDialog.submitting ? "Applying" : `${lifecycleActionLabel(lifecycleDialog.action)} account`}
                </Button>
              </div>
            </form>
          )}
        </DialogSurface>
      ) : null}

      {policyDialog && selectedUser ? (
        <DialogSurface
          title="Change authentication policy"
          description="Review the account sign-in policy before applying it."
          onClose={() => setPolicyDialog(null)}
          dirty={Boolean(policyDialog.reason)}
          busy={policyDialog.submitting}
          initialFocus="first-control"
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card text-foreground shadow-2xl"
        >
          {({ requestClose }) => (
            <form
              noValidate
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submitPolicyChange();
              }}
            >
              <div className="border-b border-border bg-muted px-5 py-4">
                <h2 data-dialog-heading="true" tabIndex={-1} className="text-lg font-black text-foreground">Change authentication policy</h2>
                <p className="mt-1 text-sm font-semibold text-muted-foreground">{selectedUser.displayName} · {selectedUser.email}</p>
              </div>

              <div className="grid gap-4 px-5">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-md border border-border bg-muted p-3">
                    <p className="text-xs font-black uppercase tracking-wider text-muted-foreground">Current policy</p>
                    <p className="mt-1 font-black text-foreground">{authenticationPolicyLabel(selectedUser.authenticationPolicy)}</p>
                  </div>
                  <div className="rounded-md border border-border bg-muted p-3">
                    <p className="text-xs font-black uppercase tracking-wider text-muted-foreground">New policy</p>
                    <p className="mt-1 font-black text-foreground">{authenticationPolicyLabel(policyDialog.authenticationPolicy)}</p>
                  </div>
                </div>
                <AlertBox tone="warning">This changes sign-in eligibility only. Roles, member profile links and access history stay unchanged.</AlertBox>
                <Field label="Reason" required error={policyDialog.error}>
                  <Textarea
                    data-dialog-initial-focus="true"
                    value={policyDialog.reason}
                    onChange={(event) => setPolicyDialog((current) => current ? { ...current, reason: event.target.value, error: "" } : current)}
                  />
                </Field>
              </div>

              <div className="flex flex-col-reverse gap-2 border-t border-border bg-muted px-5 py-4 sm:flex-row sm:justify-end">
                <Button type="button" variant="secondary" disabled={policyDialog.submitting} onClick={() => requestClose()}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" icon={KeyRound} disabled={policyDialog.submitting}>
                  {policyDialog.submitting ? "Applying" : "Apply policy"}
                </Button>
              </div>
            </form>
          )}
        </DialogSurface>
      ) : null}
    </div>
  );
}

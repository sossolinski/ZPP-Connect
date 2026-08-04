import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpenCheck, CheckCircle2, Edit3, PauseCircle, PlayCircle, Plus, RefreshCcw, ShieldCheck, XCircle } from "lucide-react";
import { PageIntro } from "../components/portal";
import { AlertBox, Badge, Button, Card, CardHeader, EmptyState, ErrorSummary, Field, Input, Loading, Select, StatusBadge, Table, Textarea } from "../components/ui";
import { DialogSurface } from "../components/DialogSurface";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";

type MemberSummary = {
  id: string;
  memberId: string;
  displayName: string;
  pool?: string;
  role?: string;
  assignedFunction?: string;
  status?: string;
};

type GroupSummary = {
  id: string;
  operationalId?: string;
  name: string;
  functionName?: string;
  status?: string;
  memberCount?: number;
};

type TrainingCourse = {
  id: string;
  code: string;
  title: string;
  description?: string;
  category: string;
  deliveryType: string;
  validityMonths?: number | null;
  active: boolean;
  selfCompletable?: boolean;
  updatedAt: string;
};

type TrainingRequirement = {
  id: string;
  courseId: string;
  course: TrainingCourse;
  targetType: "Role" | "Group" | "MemberProfile";
  targetRole?: string;
  groupId?: string;
  memberProfileId?: string;
  target?: { label?: string };
  requiredStatus: string;
  dueAt?: string | null;
  active: boolean;
  resolvedMemberCount?: number;
  updatedAt: string;
};

type TrainingRecord = {
  id: string;
  operationalId: string;
  memberProfileId: string;
  member: MemberSummary;
  courseId: string;
  course: TrainingCourse;
  sourceRequirement?: { id: string; targetType: string; targetLabel: string; requiredStatus: string } | null;
  assignedAt: string;
  dueAt?: string | null;
  status: string;
  baseStatus?: string;
  isOverdue?: boolean;
  isExpiringSoon?: boolean;
  completedAt?: string | null;
  expiryAt?: string | null;
  score?: number | null;
  completionNote?: string;
  completionRef?: string;
  verifiedAt?: string | null;
  waiverReason?: string;
  cancelledReason?: string;
  updatedAt: string;
  permissions?: {
    canStart?: boolean;
    canComplete?: boolean;
    canVerify?: boolean;
    canWaive?: boolean;
    canCancel?: boolean;
    canEdit?: boolean;
  };
};

type ApiListResult<T> = {
  data: T[];
  total: number;
  linkedMemberProfile?: MemberSummary | null;
  totals?: Record<string, number>;
};

type CourseForm = {
  code: string;
  title: string;
  category: string;
  deliveryType: string;
  validityMonths: string;
  selfCompletable: boolean;
  description: string;
};

type RequirementForm = {
  courseId: string;
  targetType: "Role" | "Group" | "MemberProfile";
  targetRole: string;
  groupId: string;
  memberProfileId: string;
  requiredStatus: string;
  dueAt: string;
};

type AssignForm = {
  targetType: "Member" | "Group";
  memberProfileId: string;
  groupId: string;
  courseId: string;
  sourceRequirementId: string;
  dueAt: string;
};

type CompleteForm = {
  completedAt: string;
  score: string;
  completionNote: string;
  completionRef: string;
};

type DrawerState =
  | { type: "course"; mode: "create" | "edit"; course?: TrainingCourse }
  | { type: "requirement"; mode: "create" | "edit"; requirement?: TrainingRequirement }
  | { type: "assign" }
  | { type: "record"; record: TrainingRecord }
  | { type: "complete"; record: TrainingRecord }
  | { type: "waive"; record: TrainingRecord }
  | { type: "cancel"; record: TrainingRecord };

const deliveryTypes = ["Classroom", "E-learning", "Briefing", "Exercise", "Practical", "Other"];
const statusOptions = ["All statuses", "Assigned", "In Progress", "Completed", "Expired", "Waived", "Cancelled"];
const targetTypes: RequirementForm["targetType"][] = ["Role", "Group", "MemberProfile"];
const roleTargets = ["ZPP Member", "TEC Member", "ZPP Group Leader", "TEC Group Leader", "ZPP Coordinator", "TEC Coordinator", "Family Assistance", "Welfare", "Documentation"];

function formatDateTime(value?: string | null) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not set";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function toDateTimeInput(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function nowInput() {
  return toDateTimeInput(new Date().toISOString());
}

function fromDateTimeInput(value: string) {
  return value ? new Date(value).toISOString() : "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Action could not be completed.";
}

function courseFormFromRecord(course?: TrainingCourse): CourseForm {
  return {
    code: course?.code ?? "",
    title: course?.title ?? "",
    category: course?.category ?? "Core",
    deliveryType: course?.deliveryType ?? "Briefing",
    validityMonths: course?.validityMonths === null || course?.validityMonths === undefined ? "" : String(course.validityMonths),
    selfCompletable: course?.selfCompletable ?? true,
    description: course?.description ?? ""
  };
}

function blankRequirementForm(courses: TrainingCourse[]): RequirementForm {
  return {
    courseId: courses.find((course) => course.active)?.id ?? courses[0]?.id ?? "",
    targetType: "Role",
    targetRole: "ZPP Member",
    groupId: "",
    memberProfileId: "",
    requiredStatus: "Required",
    dueAt: ""
  };
}

function requirementFormFromRecord(requirement?: TrainingRequirement, courses: TrainingCourse[] = []): RequirementForm {
  if (!requirement) return blankRequirementForm(courses);
  return {
    courseId: requirement.courseId,
    targetType: requirement.targetType,
    targetRole: requirement.targetRole ?? "",
    groupId: requirement.groupId ?? "",
    memberProfileId: requirement.memberProfileId ?? "",
    requiredStatus: requirement.requiredStatus,
    dueAt: toDateTimeInput(requirement.dueAt)
  };
}

function blankAssignForm(courses: TrainingCourse[], members: MemberSummary[], groups: GroupSummary[], requirements: TrainingRequirement[]): AssignForm {
  const firstRequirement = requirements.find((requirement) => requirement.active);
  return {
    targetType: "Member",
    memberProfileId: members.find((member) => member.status !== "Archived")?.id ?? members[0]?.id ?? "",
    groupId: groups.find((group) => group.status !== "Archived")?.id ?? groups[0]?.id ?? "",
    courseId: firstRequirement?.courseId ?? courses.find((course) => course.active)?.id ?? courses[0]?.id ?? "",
    sourceRequirementId: firstRequirement?.id ?? "",
    dueAt: ""
  };
}

function completeFormFromRecord(record?: TrainingRecord): CompleteForm {
  return {
    completedAt: toDateTimeInput(record?.completedAt) || nowInput(),
    score: record?.score === null || record?.score === undefined ? "" : String(record.score),
    completionNote: record?.completionNote ?? "",
    completionRef: record?.completionRef ?? ""
  };
}

function metricCard(label: string, value: string | number, detail: string) {
  return (
    <Card key={label} className="p-4">
      <p className="text-xs font-black uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-3xl font-black text-foreground">{value}</p>
      <p className="mt-1 text-sm font-semibold text-muted-foreground">{detail}</p>
    </Card>
  );
}

function recordSortValue(record: TrainingRecord) {
  if (record.isOverdue) return 0;
  if (record.status === "Assigned") return 1;
  if (record.status === "In Progress") return 2;
  if (record.isExpiringSoon) return 3;
  return 4;
}

function targetLabel(requirement: TrainingRequirement) {
  return requirement.target?.label || requirement.targetRole || requirement.groupId || requirement.memberProfileId || requirement.targetType;
}

function statusHint(record: TrainingRecord) {
  if (record.isOverdue) return "Overdue";
  if (record.isExpiringSoon) return "Expiring soon";
  return record.status;
}

export function TrainingPage() {
  const { user: authenticatedUser } = useApp();
  const permissions = useMemo(() => new Set(authenticatedUser?.permissions ?? []), [authenticatedUser?.permissions]);
  const can = useCallback((permission: string) => permissions.has(permission), [permissions]);
  const canReadAll = can("training:read-all");
  const canManageCourses = can("training:course:manage");
  const canManageRequirements = can("training:requirement:manage");
  const canAssign = can("training:assign");
  const canVerify = can("training:verify");
  const canWaive = can("training:waive");
  const showManagement = canReadAll;

  const [records, setRecords] = useState<TrainingRecord[]>([]);
  const [summaryRecords, setSummaryRecords] = useState<TrainingRecord[]>([]);
  const [courses, setCourses] = useState<TrainingCourse[]>([]);
  const [requirements, setRequirements] = useState<TrainingRequirement[]>([]);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [linkedMember, setLinkedMember] = useState<MemberSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All statuses");
  const [courseFilter, setCourseFilter] = useState("All");
  const [memberFilter, setMemberFilter] = useState("All");
  const [groupFilter, setGroupFilter] = useState("All");
  const [queueFilter, setQueueFilter] = useState("All");
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [courseForm, setCourseForm] = useState<CourseForm>(() => courseFormFromRecord());
  const [courseBaseline, setCourseBaseline] = useState<CourseForm>(() => courseFormFromRecord());
  const [requirementForm, setRequirementForm] = useState<RequirementForm>(() => blankRequirementForm([]));
  const [requirementBaseline, setRequirementBaseline] = useState<RequirementForm>(() => blankRequirementForm([]));
  const [assignForm, setAssignForm] = useState<AssignForm>(() => blankAssignForm([], [], [], []));
  const [assignBaseline, setAssignBaseline] = useState<AssignForm>(() => blankAssignForm([], [], [], []));
  const [completeForm, setCompleteForm] = useState<CompleteForm>(() => completeFormFromRecord());
  const [completeBaseline, setCompleteBaseline] = useState<CompleteForm>(() => completeFormFromRecord());
  const [reason, setReason] = useState("");
  const [reasonBaseline, setReasonBaseline] = useState("");
  const [drawerError, setDrawerError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState("");

  const recordQuery = useMemo(() => {
    const query: Record<string, string | boolean | number> = showManagement ? {} : { mine: true };
    if (search) query.search = search;
    if (statusFilter !== "All statuses") query.status = statusFilter;
    if (courseFilter !== "All") query.courseId = courseFilter;
    if (memberFilter !== "All") query.memberProfileId = memberFilter;
    if (groupFilter !== "All") query.groupId = groupFilter;
    if (queueFilter === "Overdue") query.overdue = true;
    if (queueFilter === "Expiring soon") query.expiringWithin = 45;
    query.sort = "due";
    return query;
  }, [courseFilter, groupFilter, memberFilter, queueFilter, search, showManagement, statusFilter]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const summaryQuery = showManagement ? {} : { mine: true };
      const [summaryResult, recordResult, courseResult] = await Promise.all([
        api.trainingRecords(summaryQuery) as Promise<ApiListResult<TrainingRecord>>,
        api.trainingRecords(recordQuery) as Promise<ApiListResult<TrainingRecord>>,
        api.trainingCourses({}) as Promise<ApiListResult<TrainingCourse>>
      ]);

      setSummaryRecords(summaryResult.data);
      setRecords(recordResult.data);
      setLinkedMember(recordResult.linkedMemberProfile ?? summaryResult.linkedMemberProfile ?? null);
      setCourses(courseResult.data);

      if (showManagement) {
        const [requirementResult, memberResult, groupResult] = await Promise.all([
          api.trainingRequirements({}) as Promise<ApiListResult<TrainingRequirement>>,
          api.memberProfiles({ status: "Active" }) as Promise<ApiListResult<MemberSummary>>,
          api.groups({ status: "Active" }) as Promise<ApiListResult<GroupSummary>>
        ]);
        setRequirements(requirementResult.data);
        setMembers(memberResult.data);
        setGroups(groupResult.data);
      } else {
        setRequirements([]);
        setMembers([]);
        setGroups([]);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [recordQuery, showManagement]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const sortedPersonalRecords = useMemo(() => (
    [...records].sort((left, right) => recordSortValue(left) - recordSortValue(right) || String(left.dueAt ?? "").localeCompare(String(right.dueAt ?? "")))
  ), [records]);

  const metrics = useMemo(() => {
    const active = summaryRecords.filter((record) => record.status === "Assigned" || record.status === "In Progress");
    return [
      metricCard("Action required", active.length, showManagement ? "Assigned or in progress" : "Training still to finish"),
      metricCard("Overdue", summaryRecords.filter((record) => record.isOverdue).length, "Needs attention first"),
      metricCard("Expiring soon", summaryRecords.filter((record) => record.isExpiringSoon).length, "Due within 45 days"),
      metricCard("Completed", summaryRecords.filter((record) => record.status === "Completed").length, "Current completions")
    ];
  }, [showManagement, summaryRecords]);

  const openCourseDrawer = (mode: "create" | "edit", course?: TrainingCourse) => {
    const form = courseFormFromRecord(course);
    setDrawer({ type: "course", mode, course });
    setCourseForm(form);
    setCourseBaseline(form);
    setDrawerError("");
  };

  const openRequirementDrawer = (mode: "create" | "edit", requirement?: TrainingRequirement) => {
    const form = requirementFormFromRecord(requirement, courses);
    setDrawer({ type: "requirement", mode, requirement });
    setRequirementForm(form);
    setRequirementBaseline(form);
    setDrawerError("");
  };

  const openAssignDrawer = () => {
    const form = blankAssignForm(courses, members, groups, requirements);
    setDrawer({ type: "assign" });
    setAssignForm(form);
    setAssignBaseline(form);
    setDrawerError("");
  };

  const openCompleteDrawer = (record: TrainingRecord) => {
    const form = completeFormFromRecord(record);
    setDrawer({ type: "complete", record });
    setCompleteForm(form);
    setCompleteBaseline(form);
    setDrawerError("");
  };

  const openReasonDrawer = (type: "waive" | "cancel", record: TrainingRecord) => {
    setDrawer({ type, record });
    setReason("");
    setReasonBaseline("");
    setDrawerError("");
  };

  const reloadAfter = async (message: string) => {
    setSuccess(message);
    await loadData();
  };

  const handleStart = async (record: TrainingRecord) => {
    setBusyAction(`start-${record.id}`);
    setSuccess("");
    try {
      await api.startTrainingRecord(record.id, { expectedUpdatedAt: record.updatedAt });
      await reloadAfter("Training started");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyAction("");
    }
  };

  const handleVerify = async (record: TrainingRecord) => {
    setBusyAction(`verify-${record.id}`);
    setSuccess("");
    try {
      await api.verifyTrainingRecord(record.id, { expectedUpdatedAt: record.updatedAt });
      await reloadAfter("Completion verified");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyAction("");
    }
  };

  const saveCourse = async () => {
    if (!drawer || drawer.type !== "course") return;
    setSaving(true);
    setDrawerError("");
    try {
      const body = {
        ...courseForm,
        validityMonths: courseForm.validityMonths ? Number(courseForm.validityMonths) : null,
        expectedUpdatedAt: drawer.course?.updatedAt
      };
      if (drawer.mode === "create") await api.createTrainingCourse(body);
      else if (drawer.course) await api.updateTrainingCourse(drawer.course.id, body);
      setDrawer(null);
      await reloadAfter(drawer.mode === "create" ? "Course created" : "Course updated");
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleCourseActive = async (course: TrainingCourse) => {
    setSaving(true);
    setDrawerError("");
    try {
      if (course.active) await api.deactivateTrainingCourse(course.id, { expectedUpdatedAt: course.updatedAt });
      else await api.reactivateTrainingCourse(course.id, { expectedUpdatedAt: course.updatedAt });
      setDrawer(null);
      await reloadAfter(course.active ? "Course deactivated" : "Course reactivated");
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const saveRequirement = async () => {
    if (!drawer || drawer.type !== "requirement") return;
    setSaving(true);
    setDrawerError("");
    try {
      const body = {
        courseId: requirementForm.courseId,
        targetType: requirementForm.targetType,
        targetRole: requirementForm.targetType === "Role" ? requirementForm.targetRole : "",
        groupId: requirementForm.targetType === "Group" ? requirementForm.groupId : "",
        memberProfileId: requirementForm.targetType === "MemberProfile" ? requirementForm.memberProfileId : "",
        requiredStatus: requirementForm.requiredStatus,
        dueAt: requirementForm.dueAt ? fromDateTimeInput(requirementForm.dueAt) : null,
        expectedUpdatedAt: drawer.requirement?.updatedAt
      };
      if (drawer.mode === "create") await api.createTrainingRequirement(body);
      else if (drawer.requirement) await api.updateTrainingRequirement(drawer.requirement.id, body);
      setDrawer(null);
      await reloadAfter(drawer.mode === "create" ? "Requirement added" : "Requirement updated");
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const endRequirement = async (requirement: TrainingRequirement) => {
    setSaving(true);
    setDrawerError("");
    try {
      await api.endTrainingRequirement(requirement.id, { expectedUpdatedAt: requirement.updatedAt });
      setDrawer(null);
      await reloadAfter("Requirement ended");
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const assignTraining = async () => {
    setSaving(true);
    setDrawerError("");
    try {
      const result = await api.assignTrainingRecord({
        ...(assignForm.targetType === "Group" ? { groupId: assignForm.groupId } : { memberProfileId: assignForm.memberProfileId }),
        courseId: assignForm.courseId,
        sourceRequirementId: assignForm.sourceRequirementId || null,
        dueAt: assignForm.dueAt ? fromDateTimeInput(assignForm.dueAt) : null
      }) as { assignedCount?: number; skippedCount?: number };
      setDrawer(null);
      if (assignForm.targetType === "Group") {
        const assignedCount = result.assignedCount ?? 0;
        const skippedCount = result.skippedCount ?? 0;
        await reloadAfter(`Training assigned to ${assignedCount} group member${assignedCount === 1 ? "" : "s"}${skippedCount ? `; ${skippedCount} already had it` : ""}`);
      } else {
        await reloadAfter("Training assigned");
      }
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const completeTraining = async (record: TrainingRecord) => {
    setSaving(true);
    setDrawerError("");
    try {
      await api.completeTrainingRecord(record.id, {
        expectedUpdatedAt: record.updatedAt,
        completedAt: fromDateTimeInput(completeForm.completedAt),
        score: completeForm.score ? Number(completeForm.score) : null,
        completionNote: completeForm.completionNote,
        completionRef: completeForm.completionRef
      });
      setDrawer(null);
      await reloadAfter("Completion recorded");
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const submitReasonAction = async (record: TrainingRecord, type: "waive" | "cancel") => {
    setSaving(true);
    setDrawerError("");
    try {
      if (type === "waive") await api.waiveTrainingRecord(record.id, { expectedUpdatedAt: record.updatedAt, reason });
      else await api.cancelTrainingRecord(record.id, { expectedUpdatedAt: record.updatedAt, reason });
      setDrawer(null);
      await reloadAfter(type === "waive" ? "Training waived" : "Training cancelled");
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const updateAssignRequirement = (requirementId: string) => {
    setAssignForm((form) => {
      const requirement = requirements.find((item) => item.id === requirementId);
      if (!requirement) return { ...form, sourceRequirementId: "" };
      const next: AssignForm = { ...form, sourceRequirementId: requirementId, courseId: requirement.courseId };
      if (requirement.targetType === "Group" && requirement.groupId) return { ...next, targetType: "Group", groupId: requirement.groupId };
      if (requirement.targetType === "MemberProfile" && requirement.memberProfileId) return { ...next, targetType: "Member", memberProfileId: requirement.memberProfileId };
      return next;
    });
  };

  const updateAssignCourse = (courseId: string) => {
    setAssignForm((form) => ({
      ...form,
      courseId,
      sourceRequirementId: requirements.find((requirement) => requirement.id === form.sourceRequirementId)?.courseId === courseId ? form.sourceRequirementId : ""
    }));
  };

  const renderRecordActions = (record: TrainingRecord) => (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" icon={BookOpenCheck} onClick={() => setDrawer({ type: "record", record })}>View</Button>
      {record.permissions?.canStart ? (
        <Button size="sm" variant="secondary" icon={PlayCircle} disabled={busyAction === `start-${record.id}`} onClick={() => void handleStart(record)}>
          Start
        </Button>
      ) : null}
      {record.permissions?.canComplete ? (
        <Button size="sm" variant="create" icon={CheckCircle2} onClick={() => openCompleteDrawer(record)}>Complete</Button>
      ) : null}
      {record.permissions?.canVerify && canVerify ? (
        <Button size="sm" variant="secondary" icon={ShieldCheck} disabled={busyAction === `verify-${record.id}`} onClick={() => void handleVerify(record)}>
          Verify
        </Button>
      ) : null}
      {record.permissions?.canWaive && canWaive ? (
        <Button size="sm" variant="warning" icon={PauseCircle} onClick={() => openReasonDrawer("waive", record)}>Waive</Button>
      ) : null}
      {record.permissions?.canCancel ? (
        <Button size="sm" variant="danger" icon={XCircle} onClick={() => openReasonDrawer("cancel", record)}>Cancel</Button>
      ) : null}
    </div>
  );

  const personalRecordCard = (record: TrainingRecord) => (
    <Card key={record.id} className="p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge value={statusHint(record)} />
            {record.sourceRequirement ? <Badge tone="info">{record.sourceRequirement.targetLabel}</Badge> : null}
          </div>
          <h3 className="mt-3 text-lg font-black text-foreground">{record.course.title}</h3>
          <p className="mt-1 text-sm font-semibold leading-6 text-muted-foreground">{record.course.description || record.course.category}</p>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="font-black uppercase tracking-wide text-muted-foreground">Due</dt>
              <dd className="font-semibold text-foreground">{formatDateTime(record.dueAt)}</dd>
            </div>
            <div>
              <dt className="font-black uppercase tracking-wide text-muted-foreground">Completion</dt>
              <dd className="font-semibold text-foreground">{formatDateTime(record.completedAt)}</dd>
            </div>
            <div>
              <dt className="font-black uppercase tracking-wide text-muted-foreground">Valid until</dt>
              <dd className="font-semibold text-foreground">{formatDateTime(record.expiryAt)}</dd>
            </div>
          </dl>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">{renderRecordActions(record)}</div>
      </div>
    </Card>
  );

  const selectedAssignGroup = groups.find((group) => group.id === assignForm.groupId);

  return (
    <>
      <PageIntro
        eyebrow={showManagement ? "Training management" : "My training"}
        title="Training"
        description={showManagement ? "Track required courses, due records and verified completions for the response team." : "Start with overdue or assigned training, then complete eligible items when ready."}
      />

      <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-4">{metrics}</div>

      {success ? <AlertBox tone="success" dismissible className="mt-4">{success}</AlertBox> : null}
      {error ? <AlertBox tone="danger" dismissible className="mt-4">{error}</AlertBox> : null}

      {loading ? (
        <Card className="mt-5 p-5"><Loading label="Loading training" /></Card>
      ) : error && !records.length && !summaryRecords.length ? (
        <Card className="mt-5 p-5">
          <EmptyState title="Unable to load training" detail="Check your connection and try again." action={<Button icon={RefreshCcw} onClick={() => void loadData()}>Retry</Button>} />
        </Card>
      ) : showManagement ? (
        <div className="mt-5 grid gap-5">
          <Card>
            <CardHeader
              title="Filters"
              description="Narrow the training queue before taking action."
              action={canAssign ? <Button variant="create" icon={Plus} onClick={openAssignDrawer}>Assign training</Button> : null}
            />
            <div className="grid gap-3 p-4 lg:grid-cols-[minmax(260px,1.5fr)_repeat(4,minmax(150px,1fr))]">
              <Field label="Search">
                <Input value={search} placeholder="Course, member, record ID" onChange={(event) => setSearch(event.target.value)} />
              </Field>
              <Field label="Status">
                <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                  {statusOptions.map((status) => <option key={status}>{status}</option>)}
                </Select>
              </Field>
              <Field label="Course">
                <Select value={courseFilter} onChange={(event) => setCourseFilter(event.target.value)}>
                  <option value="All">All courses</option>
                  {courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}
                </Select>
              </Field>
              <Field label="Member">
                <Select value={memberFilter} onChange={(event) => setMemberFilter(event.target.value)}>
                  <option value="All">All members</option>
                  {members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
                </Select>
              </Field>
              <Field label="Queue">
                <Select value={queueFilter} onChange={(event) => setQueueFilter(event.target.value)}>
                  <option>All</option>
                  <option>Overdue</option>
                  <option>Expiring soon</option>
                </Select>
              </Field>
              <Field label="Group">
                <Select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
                  <option value="All">All groups</option>
                  {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </Select>
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="Training Records" description="Use dedicated actions for start, completion, verification, waiver and cancellation." />
            <div className="p-4">
              <Table
                rows={records}
                minWidth="min-w-[1120px] w-full"
                actionWidth="w-80"
                emptyTitle="No training records found"
                emptyDetail="No results match the selected filters."
                rowAction={(row) => renderRecordActions(row as TrainingRecord)}
                columns={[
                  {
                    key: "member",
                    label: "Member",
                    render: (row) => {
                      const record = row as TrainingRecord;
                      return (
                        <div>
                          <p className="font-black text-foreground">{record.member.displayName}</p>
                          <p className="text-xs font-bold text-muted-foreground">{record.member.memberId} · {record.member.assignedFunction}</p>
                        </div>
                      );
                    }
                  },
                  {
                    key: "course",
                    label: "Course",
                    render: (row) => {
                      const record = row as TrainingRecord;
                      return (
                        <div>
                          <p className="font-black text-foreground">{record.course.title}</p>
                          <p className="text-xs font-bold text-muted-foreground">{record.course.code} · {record.course.category}</p>
                        </div>
                      );
                    }
                  },
                  { key: "status", label: "Status", render: (row) => <StatusBadge value={statusHint(row as TrainingRecord)} /> },
                  { key: "dueAt", label: "Due", render: (row) => formatDateTime((row as TrainingRecord).dueAt) },
                  { key: "expiryAt", label: "Valid until", render: (row) => formatDateTime((row as TrainingRecord).expiryAt) }
                ]}
              />
            </div>
          </Card>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card>
              <CardHeader
                title="Courses"
                description="Inactive courses remain readable for historical completion records."
                action={canManageCourses ? <Button variant="create" icon={Plus} onClick={() => openCourseDrawer("create")}>New course</Button> : null}
              />
              <div className="p-4">
                <Table
                  rows={courses}
                  minWidth="min-w-[720px] w-full"
                  emptyTitle="No courses found"
                  emptyDetail="Courses created here will appear in this list."
                  rowAction={canManageCourses ? (row) => <Button size="sm" variant="secondary" icon={Edit3} onClick={() => openCourseDrawer("edit", row as TrainingCourse)}>Edit</Button> : undefined}
                  columns={[
                    { key: "title", label: "Course", render: (row) => <div><p className="font-black text-foreground">{(row as TrainingCourse).title}</p><p className="text-xs font-bold text-muted-foreground">{(row as TrainingCourse).code}</p></div> },
                    { key: "category", label: "Category" },
                    { key: "deliveryType", label: "Delivery" },
                    { key: "active", label: "State", render: (row) => <StatusBadge value={(row as TrainingCourse).active ? "Active" : "Inactive"} /> }
                  ]}
                />
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Requirements"
                description="Requirements define who needs which course and by when."
                action={canManageRequirements ? <Button variant="create" icon={Plus} onClick={() => openRequirementDrawer("create")}>New requirement</Button> : null}
              />
              <div className="p-4">
                <Table
                  rows={requirements}
                  minWidth="min-w-[760px] w-full"
                  emptyTitle="No requirements found"
                  emptyDetail="Requirements created here will appear in this list."
                  rowAction={canManageRequirements ? (row) => <Button size="sm" variant="secondary" icon={Edit3} onClick={() => openRequirementDrawer("edit", row as TrainingRequirement)}>Edit</Button> : undefined}
                  columns={[
                    { key: "course", label: "Course", render: (row) => (row as TrainingRequirement).course.title },
                    { key: "target", label: "Target", render: (row) => targetLabel(row as TrainingRequirement) },
                    { key: "dueAt", label: "Due", render: (row) => formatDateTime((row as TrainingRequirement).dueAt) },
                    { key: "active", label: "State", render: (row) => <StatusBadge value={(row as TrainingRequirement).active ? "Active" : "Ended"} /> }
                  ]}
                />
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <Card className="mt-5">
          <CardHeader
            title="My training"
            description={linkedMember ? `${linkedMember.displayName} · ${linkedMember.memberId}` : "Your linked member profile controls this list."}
          />
          <div className="grid gap-3 p-4">
            {!linkedMember ? (
              <EmptyState title="No linked member profile" detail="Ask a coordinator to link your account before personal training appears." />
            ) : sortedPersonalRecords.length ? (
              sortedPersonalRecords.map(personalRecordCard)
            ) : (
              <EmptyState title="No training assigned" detail="Assigned training will appear here when it is added to your profile." />
            )}
          </div>
        </Card>
      )}

      {drawer?.type === "record" ? (
        <DialogSurface
          title="Training record"
          description={drawer.record.course.title}
          onClose={() => setDrawer(null)}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          <div className="border-b border-border p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 data-dialog-heading="true" tabIndex={-1} className="text-xl font-black text-foreground">{drawer.record.course.title}</h2>
                <p className="mt-1 text-sm font-semibold text-muted-foreground">{drawer.record.operationalId} · {drawer.record.member.displayName}</p>
              </div>
              <Button variant="ghost" onClick={() => setDrawer(null)}>Close</Button>
            </div>
          </div>
          <div className="scrollbar-soft grid flex-1 content-start gap-4 overflow-y-auto p-5">
            <div className="rounded-lg border border-border bg-muted p-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge value={statusHint(drawer.record)} />
                {drawer.record.sourceRequirement ? <Badge tone="info">{drawer.record.sourceRequirement.targetLabel}</Badge> : null}
              </div>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <div><dt className="text-xs font-black uppercase text-muted-foreground">Assigned</dt><dd className="font-semibold text-foreground">{formatDateTime(drawer.record.assignedAt)}</dd></div>
                <div><dt className="text-xs font-black uppercase text-muted-foreground">Due</dt><dd className="font-semibold text-foreground">{formatDateTime(drawer.record.dueAt)}</dd></div>
                <div><dt className="text-xs font-black uppercase text-muted-foreground">Completed</dt><dd className="font-semibold text-foreground">{formatDateTime(drawer.record.completedAt)}</dd></div>
                <div><dt className="text-xs font-black uppercase text-muted-foreground">Valid until</dt><dd className="font-semibold text-foreground">{formatDateTime(drawer.record.expiryAt)}</dd></div>
              </dl>
            </div>
            {drawer.record.completionNote ? <AlertBox tone="success">{drawer.record.completionNote}</AlertBox> : null}
            <div>{renderRecordActions(drawer.record)}</div>
          </div>
        </DialogSurface>
      ) : null}

      {drawer?.type === "course" ? (
        <DialogSurface
          title={drawer.mode === "create" ? "New course" : "Edit course"}
          onClose={() => setDrawer(null)}
          busy={saving}
          dirty={JSON.stringify(courseForm) !== JSON.stringify(courseBaseline)}
          initialFocus="first-control"
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void saveCourse(); }}>
            <div className="border-b border-border p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 data-dialog-heading="true" tabIndex={-1} className="text-xl font-black text-foreground">{drawer.mode === "create" ? "New course" : "Edit course"}</h2>
                  <p className="mt-1 text-sm font-semibold text-muted-foreground">Use a clear title and keep inactive courses readable for history.</p>
                </div>
                <Button variant="ghost" type="button" onClick={() => setDrawer(null)}>Close</Button>
              </div>
            </div>
            <div className="scrollbar-soft grid flex-1 content-start gap-4 overflow-y-auto p-5">
              <ErrorSummary title="Course could not be saved" errors={drawerError ? [{ message: drawerError }] : []} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Code" required><Input data-dialog-initial-focus="true" value={courseForm.code} onChange={(event) => setCourseForm((form) => ({ ...form, code: event.target.value }))} /></Field>
                <Field label="Title" required><Input value={courseForm.title} onChange={(event) => setCourseForm((form) => ({ ...form, title: event.target.value }))} /></Field>
                <Field label="Category"><Input value={courseForm.category} onChange={(event) => setCourseForm((form) => ({ ...form, category: event.target.value }))} /></Field>
                <Field label="Delivery type">
                  <Select value={courseForm.deliveryType} onChange={(event) => setCourseForm((form) => ({ ...form, deliveryType: event.target.value }))}>
                    {deliveryTypes.map((type) => <option key={type}>{type}</option>)}
                  </Select>
                </Field>
                <Field label="Validity months"><Input type="number" min="0" value={courseForm.validityMonths} onChange={(event) => setCourseForm((form) => ({ ...form, validityMonths: event.target.value }))} /></Field>
                <label className="flex items-center gap-2 self-end rounded-md border border-border bg-muted px-3 py-2 text-sm font-bold text-foreground">
                  <input type="checkbox" checked={courseForm.selfCompletable} onChange={(event) => setCourseForm((form) => ({ ...form, selfCompletable: event.target.checked }))} />
                  Member can complete own record
                </label>
              </div>
              <Field label="Description"><Textarea value={courseForm.description} onChange={(event) => setCourseForm((form) => ({ ...form, description: event.target.value }))} /></Field>
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-border bg-card p-4 sm:flex-row sm:justify-between">
              {drawer.mode === "edit" && drawer.course ? (
                <Button type="button" variant={drawer.course.active ? "warning" : "success"} disabled={saving} onClick={() => void toggleCourseActive(drawer.course!)}>
                  {drawer.course.active ? "Deactivate course" : "Reactivate course"}
                </Button>
              ) : <span />}
              <Button type="submit" variant="create" icon={CheckCircle2} disabled={saving}>{saving ? "Saving..." : "Save course"}</Button>
            </div>
          </form>
        </DialogSurface>
      ) : null}

      {drawer?.type === "requirement" ? (
        <DialogSurface
          title={drawer.mode === "create" ? "New requirement" : "Edit requirement"}
          onClose={() => setDrawer(null)}
          busy={saving}
          dirty={JSON.stringify(requirementForm) !== JSON.stringify(requirementBaseline)}
          initialFocus="first-control"
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void saveRequirement(); }}>
            <div className="border-b border-border p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 data-dialog-heading="true" tabIndex={-1} className="text-xl font-black text-foreground">{drawer.mode === "create" ? "New requirement" : "Edit requirement"}</h2>
                  <p className="mt-1 text-sm font-semibold text-muted-foreground">Choose one target for this required course.</p>
                </div>
                <Button variant="ghost" type="button" onClick={() => setDrawer(null)}>Close</Button>
              </div>
            </div>
            <div className="scrollbar-soft grid flex-1 content-start gap-4 overflow-y-auto p-5">
              <ErrorSummary title="Requirement could not be saved" errors={drawerError ? [{ message: drawerError }] : []} />
              <Field label="Course" required>
                <Select data-dialog-initial-focus="true" value={requirementForm.courseId} onChange={(event) => setRequirementForm((form) => ({ ...form, courseId: event.target.value }))}>
                  {courses.filter((course) => course.active || course.id === drawer.requirement?.courseId).map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Target type" required>
                  <Select value={requirementForm.targetType} onChange={(event) => setRequirementForm((form) => ({ ...form, targetType: event.target.value as RequirementForm["targetType"] }))}>
                    {targetTypes.map((type) => <option key={type}>{type}</option>)}
                  </Select>
                </Field>
                {requirementForm.targetType === "Role" ? (
                  <Field label="Role target" required>
                    <Select value={requirementForm.targetRole} onChange={(event) => setRequirementForm((form) => ({ ...form, targetRole: event.target.value }))}>
                      {roleTargets.map((role) => <option key={role}>{role}</option>)}
                    </Select>
                  </Field>
                ) : requirementForm.targetType === "Group" ? (
                  <Field label="Group" required>
                    <Select value={requirementForm.groupId} onChange={(event) => setRequirementForm((form) => ({ ...form, groupId: event.target.value }))}>
                      <option value="">Select group</option>
                      {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                    </Select>
                  </Field>
                ) : (
                  <Field label="Member" required>
                    <Select value={requirementForm.memberProfileId} onChange={(event) => setRequirementForm((form) => ({ ...form, memberProfileId: event.target.value }))}>
                      <option value="">Select member</option>
                      {members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
                    </Select>
                  </Field>
                )}
                <Field label="Requirement status">
                  <Select value={requirementForm.requiredStatus} onChange={(event) => setRequirementForm((form) => ({ ...form, requiredStatus: event.target.value }))}>
                    <option>Required</option>
                    <option>Recommended</option>
                  </Select>
                </Field>
                <Field label="Due"><Input type="datetime-local" value={requirementForm.dueAt} onChange={(event) => setRequirementForm((form) => ({ ...form, dueAt: event.target.value }))} /></Field>
              </div>
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-border bg-card p-4 sm:flex-row sm:justify-between">
              {drawer.mode === "edit" && drawer.requirement?.active ? (
                <Button type="button" variant="warning" disabled={saving} onClick={() => void endRequirement(drawer.requirement!)}>End requirement</Button>
              ) : <span />}
              <Button type="submit" variant="create" icon={CheckCircle2} disabled={saving}>{saving ? "Saving..." : "Save requirement"}</Button>
            </div>
          </form>
        </DialogSurface>
      ) : null}

      {drawer?.type === "assign" ? (
        <DialogSurface
          title="Assign training"
          onClose={() => setDrawer(null)}
          busy={saving}
          dirty={JSON.stringify(assignForm) !== JSON.stringify(assignBaseline)}
          initialFocus="first-control"
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void assignTraining(); }}>
            <div className="border-b border-border p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 data-dialog-heading="true" tabIndex={-1} className="text-xl font-black text-foreground">Assign training</h2>
                  <p className="mt-1 text-sm font-semibold text-muted-foreground">Add a course to one member profile or an operational group.</p>
                </div>
                <Button variant="ghost" type="button" onClick={() => setDrawer(null)}>Close</Button>
              </div>
            </div>
            <div className="scrollbar-soft grid flex-1 content-start gap-4 overflow-y-auto p-5">
              <ErrorSummary title="Training could not be assigned" errors={drawerError ? [{ message: drawerError }] : []} />
              <Field label="Assign to" required>
                <Select
                  data-dialog-initial-focus="true"
                  value={assignForm.targetType}
                  onChange={(event) => setAssignForm((form) => ({
                    ...form,
                    targetType: event.target.value as AssignForm["targetType"],
                    sourceRequirementId: ""
                  }))}
                >
                  <option value="Member">One member</option>
                  <option value="Group">Group</option>
                </Select>
              </Field>
              {assignForm.targetType === "Group" ? (
                <Field label="Group" required>
                  <Select value={assignForm.groupId} onChange={(event) => setAssignForm((form) => ({ ...form, groupId: event.target.value }))}>
                    {groups.map((group) => <option key={group.id} value={group.id}>{group.name} · {group.memberCount ?? 0} members</option>)}
                  </Select>
                  <p className="text-xs font-semibold text-muted-foreground">
                    {selectedAssignGroup ? `${selectedAssignGroup.memberCount ?? 0} members will be checked for this course. Existing active assignments are skipped.` : "Choose the group that needs this training."}
                  </p>
                </Field>
              ) : (
                <Field label="Member" required>
                  <Select value={assignForm.memberProfileId} onChange={(event) => setAssignForm((form) => ({ ...form, memberProfileId: event.target.value }))}>
                    {members.map((member) => <option key={member.id} value={member.id}>{member.displayName} · {member.memberId}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="Course" required>
                <Select value={assignForm.courseId} onChange={(event) => updateAssignCourse(event.target.value)}>
                  {courses.filter((course) => course.active).map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}
                </Select>
              </Field>
              <Field label="Requirement">
                <Select value={assignForm.sourceRequirementId} onChange={(event) => updateAssignRequirement(event.target.value)}>
                  <option value="">No linked requirement</option>
                  {requirements.filter((requirement) => requirement.active).map((requirement) => <option key={requirement.id} value={requirement.id}>{requirement.course.title} · {targetLabel(requirement)}</option>)}
                </Select>
              </Field>
              <Field label="Due"><Input type="datetime-local" value={assignForm.dueAt} onChange={(event) => setAssignForm((form) => ({ ...form, dueAt: event.target.value }))} /></Field>
            </div>
            <div className="border-t border-border bg-card p-4">
              <Button type="submit" variant="create" icon={CheckCircle2} disabled={saving} className="w-full">{saving ? "Assigning..." : "Assign training"}</Button>
            </div>
          </form>
        </DialogSurface>
      ) : null}

      {drawer?.type === "complete" ? (
        <DialogSurface
          title="Record completion"
          onClose={() => setDrawer(null)}
          busy={saving}
          dirty={JSON.stringify(completeForm) !== JSON.stringify(completeBaseline)}
          initialFocus="first-control"
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void completeTraining(drawer.record); }}>
            <div className="border-b border-border p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 data-dialog-heading="true" tabIndex={-1} className="text-xl font-black text-foreground">Record completion</h2>
                  <p className="mt-1 text-sm font-semibold text-muted-foreground">{drawer.record.course.title}</p>
                </div>
                <Button variant="ghost" type="button" onClick={() => setDrawer(null)}>Close</Button>
              </div>
            </div>
            <div className="scrollbar-soft grid flex-1 content-start gap-4 overflow-y-auto p-5">
              <ErrorSummary title="Completion could not be recorded" errors={drawerError ? [{ message: drawerError }] : []} />
              <Field label="Completion time" required><Input data-dialog-initial-focus="true" type="datetime-local" value={completeForm.completedAt} onChange={(event) => setCompleteForm((form) => ({ ...form, completedAt: event.target.value }))} /></Field>
              <Field label="Score"><Input type="number" min="0" max="100" value={completeForm.score} onChange={(event) => setCompleteForm((form) => ({ ...form, score: event.target.value }))} /></Field>
              <Field label="Reference"><Input value={completeForm.completionRef} onChange={(event) => setCompleteForm((form) => ({ ...form, completionRef: event.target.value }))} /></Field>
              <Field label="Note"><Textarea value={completeForm.completionNote} onChange={(event) => setCompleteForm((form) => ({ ...form, completionNote: event.target.value }))} /></Field>
            </div>
            <div className="border-t border-border bg-card p-4">
              <Button type="submit" variant="create" icon={CheckCircle2} disabled={saving} className="w-full">{saving ? "Saving..." : "Record completion"}</Button>
            </div>
          </form>
        </DialogSurface>
      ) : null}

      {(drawer?.type === "waive" || drawer?.type === "cancel") ? (
        <DialogSurface
          title={drawer.type === "waive" ? "Waive training" : "Cancel training"}
          onClose={() => setDrawer(null)}
          busy={saving}
          dirty={reason !== reasonBaseline}
          initialFocus="first-control"
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-foreground shadow-2xl"
        >
          <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void submitReasonAction(drawer.record, drawer.type); }}>
            <div>
              <h2 data-dialog-heading="true" tabIndex={-1} className="text-lg font-black text-foreground">{drawer.type === "waive" ? "Waive training" : "Cancel training"}</h2>
              <p className="mt-1 text-sm font-semibold leading-6 text-muted-foreground">{drawer.record.course.title} · {drawer.record.member.displayName}</p>
            </div>
            <ErrorSummary title="Action could not be completed" errors={drawerError ? [{ message: drawerError }] : []} />
            <Field label="Reason" required><Textarea data-dialog-initial-focus="true" value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" disabled={saving} onClick={() => setDrawer(null)}>Cancel</Button>
              <Button type="submit" variant={drawer.type === "waive" ? "warning" : "danger"} disabled={saving}>{saving ? "Saving..." : drawer.type === "waive" ? "Waive training" : "Cancel training"}</Button>
            </div>
          </form>
        </DialogSurface>
      ) : null}
    </>
  );
}

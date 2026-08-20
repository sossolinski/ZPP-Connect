import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpenCheck, CheckCircle2, Edit3, ExternalLink, Layers3, Plus, ShieldCheck, XCircle } from "lucide-react";
import { PageIntro } from "../components/portal";
import { AlertBox, Badge, Button, Card, CardHeader, EmptyState, ErrorSummary, Field, Input, Loading, Select, StatusBadge, Table, Textarea } from "../components/ui";
import { DialogSurface } from "../components/DialogSurface";
import { useApp } from "../lib/app-context";
import { api } from "../lib/api";
import type { AnyRecord } from "../lib/types";

type DocumentSummary = AnyRecord & {
  id: string;
  code: string;
  title: string;
  description: string;
  category: string;
  ownerFunction: string;
  active: boolean;
  status: string;
  updatedAt: string;
  currentVersion?: DocumentVersion | null;
  versionCount?: number;
  activeRequirementCount?: number;
  acknowledgementCount?: number;
  outstandingCount?: number;
  version: number;
};

type DocumentVersion = AnyRecord & {
  id: string;
  documentId: string;
  title: string;
  versionLabel: string;
  status: "Draft" | "Published" | "Superseded" | "Withdrawn";
  contentMode: "Internal text" | "External link";
  contentAvailable: boolean;
  externalUrl?: string;
  changeSummary?: string;
  effectiveFrom?: string | null;
  reviewDueAt?: string | null;
  publishedAt?: string | null;
  publishedById?: string | null;
  withdrawnAt?: string | null;
  withdrawnById?: string | null;
  withdrawReason?: string | null;
  requirementCount?: number;
  acknowledgementCount?: number;
  outstandingCount?: number;
  basePublishedVersionId?: string | null;
  version: number;
  updatedAt: string;
};

type DocumentRequirement = AnyRecord & {
  id: string;
  documentVersionId: string;
  documentId: string;
  document: DocumentSummary;
  version: DocumentVersion;
  targetType: "Role" | "Group" | "MemberProfile";
  targetRole?: string;
  groupId?: string;
  memberProfileId?: string;
  targetLabel: string;
  target?: { member?: MemberOption; group?: GroupOption };
  acknowledgementRequired: boolean;
  dueAt?: string | null;
  active: boolean;
  effective: boolean;
  recordVersion: number;
  updatedAt: string;
};

type PersonalDocument = AnyRecord & {
  id: string;
  documentId: string;
  documentVersionId: string;
  code: string;
  title: string;
  description: string;
  category: string;
  ownerFunction: string;
  versionLabel: string;
  contentMode: "Internal text" | "External link";
  contentAvailable: boolean;
  dueAt?: string | null;
  status: "Awareness" | "Required" | "Overdue" | "Acknowledged";
  acknowledgedAt?: string | null;
  reasons: Array<{ id: string; label: string; targetType: string }>;
  canAcknowledge: boolean;
};

type MemberOption = { id: string; displayName: string; memberId: string; status: string };
type GroupOption = { id: string; name: string; operationalId: string; status: string; memberCount: number };

type DrawerState =
  | { type: "content"; obligation?: PersonalDocument; title: string }
  | { type: "document"; mode: "create" | "edit"; document?: DocumentSummary }
  | { type: "versions"; document: DocumentSummary }
  | { type: "version"; mode: "create" | "edit"; documentId: string; version?: DocumentVersion }
  | { type: "requirement"; mode: "create" | "edit"; requirement?: DocumentRequirement }
  | { type: "acknowledge-behalf"; requirement: DocumentRequirement };

const targetTypes = ["Role", "Group", "MemberProfile"] as const;
const roleTargets = ["ZPP Member", "TEC Member", "ZPP Group Leader", "TEC Group Leader", "ZPP Coordinator", "TEC Coordinator", "Family Assistance", "Welfare Support", "Rostering"];
const contentModes = ["Internal text", "External link"] as const;

const blankDocumentForm = {
  code: "",
  title: "",
  description: "",
  category: "Operational",
  ownerFunction: "ZPP"
};

const blankVersionForm = {
  versionLabel: "",
  changeSummary: "",
  contentMode: "Internal text",
  contentBody: "",
  externalUrl: "",
  effectiveFrom: "",
  reviewDueAt: ""
};

const blankRequirementForm = {
  documentVersionId: "",
  targetType: "Role",
  targetRole: "ZPP Member",
  groupId: "",
  memberProfileId: "",
  acknowledgementRequired: true,
  dueAt: ""
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Action could not be completed.";
}

function formatDateTime(value?: string | null) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not set";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function toDateInput(value?: string | null) {
  return value ? value.slice(0, 16) : "";
}

function documentFormFrom(document?: DocumentSummary) {
  if (!document) return { ...blankDocumentForm };
  return {
    code: document.code ?? "",
    title: document.title ?? "",
    description: document.description ?? "",
    category: document.category ?? "Operational",
    ownerFunction: document.ownerFunction ?? "ZPP"
  };
}

function versionFormFrom(version?: DocumentVersion) {
  if (!version) return { ...blankVersionForm };
  return {
    versionLabel: version.versionLabel ?? "",
    changeSummary: version.changeSummary ?? "",
    contentMode: version.contentMode ?? "Internal text",
    contentBody: version.contentBody ?? "",
    externalUrl: version.externalUrl ?? "",
    effectiveFrom: toDateInput(version.effectiveFrom),
    reviewDueAt: toDateInput(version.reviewDueAt)
  };
}

function requirementFormFrom(requirement?: DocumentRequirement, fallbackVersionId = "", fallbackGroupId = "", fallbackMemberId = "") {
  if (!requirement) {
    return {
      ...blankRequirementForm,
      documentVersionId: fallbackVersionId,
      groupId: fallbackGroupId,
      memberProfileId: fallbackMemberId
    };
  }
  return {
    documentVersionId: requirement.documentVersionId ?? fallbackVersionId,
    targetType: requirement.targetType ?? "Role",
    targetRole: requirement.targetRole || "ZPP Member",
    groupId: requirement.groupId || fallbackGroupId,
    memberProfileId: requirement.memberProfileId || fallbackMemberId,
    acknowledgementRequired: Boolean(requirement.acknowledgementRequired),
    dueAt: toDateInput(requirement.dueAt)
  };
}

export function DocumentsPage() {
  const { can } = useApp();
  const canReadAll = can("document:read-all");
  const canManageDocuments = can("document:manage");
  const canManageVersions = can("document:version:manage");
  const canPublish = can("document:publish");
  const canManageRequirements = can("document:requirement:manage");
  const canAcknowledgeAll = can("document:acknowledge-all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [drawerError, setDrawerError] = useState("");
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [personalDocuments, setPersonalDocuments] = useState<PersonalDocument[]>([]);
  const [requirements, setRequirements] = useState<DocumentRequirement[]>([]);
  const [acknowledgements, setAcknowledgements] = useState<AnyRecord[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [memberLookup, setMemberLookup] = useState("");
  const [groupLookup, setGroupLookup] = useState("");
  const [linkedMember, setLinkedMember] = useState<AnyRecord | null>(null);
  const [versionRows, setVersionRows] = useState<DocumentVersion[]>([]);
  const [contentRecord, setContentRecord] = useState<AnyRecord | null>(null);
  const [search, setSearch] = useState("");
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [documentForm, setDocumentForm] = useState(blankDocumentForm);
  const [documentBaseline, setDocumentBaseline] = useState(blankDocumentForm);
  const [versionForm, setVersionForm] = useState(blankVersionForm);
  const [versionBaseline, setVersionBaseline] = useState(blankVersionForm);
  const [requirementForm, setRequirementForm] = useState(blankRequirementForm);
  const [requirementBaseline, setRequirementBaseline] = useState(blankRequirementForm);
  const [behalfForm, setBehalfForm] = useState({ memberProfileId: "", note: "" });
  const [documentOffset, setDocumentOffset] = useState(0);
  const [requirementOffset, setRequirementOffset] = useState(0);
  const [acknowledgementOffset, setAcknowledgementOffset] = useState(0);
  const [documentTotal, setDocumentTotal] = useState(0);
  const [requirementTotal, setRequirementTotal] = useState(0);
  const [acknowledgementTotal, setAcknowledgementTotal] = useState(0);
  const [totals, setTotals] = useState<AnyRecord>({});
  const pageSize = 50;

  const publishedVersionOptions = useMemo(
    () => documents
      .map((document) => document.currentVersion ? { ...document.currentVersion, documentTitle: document.title, documentCode: document.code } : null)
      .filter(Boolean) as Array<DocumentVersion & { documentTitle: string; documentCode: string }>,
    [documents]
  );

  const filteredDocuments = useMemo(() => {
    return documents;
  }, [documents]);

  const filteredPersonalDocuments = useMemo(() => {
    return personalDocuments;
  }, [personalDocuments]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (canReadAll) {
        const [documentList, requirementList, acknowledgementList, memberList, groupList] = await Promise.all([
          api.documentsPage({ search: search || undefined, limit: pageSize, offset: documentOffset }),
          api.documentRequirementsPage({ limit: pageSize, offset: requirementOffset }).catch(() => ({ total: 0, data: [] })),
          api.documentAcknowledgementsPage({ limit: pageSize, offset: acknowledgementOffset }).catch(() => ({ total: 0, data: [] })),
          api.memberProfilesPage({ status: "Active", limit: 50, offset: 0 }).catch(() => ({ total: 0, data: [] })),
          api.groupsPage({ status: "Active", limit: 50, offset: 0 }).catch(() => ({ total: 0, data: [] }))
        ]);
        setDocuments(documentList.data as DocumentSummary[]);
        setRequirements(requirementList.data as DocumentRequirement[]);
        setAcknowledgements(acknowledgementList.data);
        setDocumentTotal(documentList.total ?? documentList.data.length);
        setRequirementTotal(requirementList.total ?? requirementList.data.length);
        setAcknowledgementTotal(acknowledgementList.total ?? acknowledgementList.data.length);
        setTotals((documentList as AnyRecord).totals ?? {});
        setMembers(memberList.data as MemberOption[]);
        setGroups(groupList.data as GroupOption[]);
        setPersonalDocuments([]);
        setLinkedMember(null);
      } else {
        const personal = await api.documentsPage({ mine: true, search: search || undefined, limit: pageSize, offset: documentOffset });
        setPersonalDocuments(personal.data as PersonalDocument[]);
        setLinkedMember((personal as AnyRecord).linkedMemberProfile ?? null);
        setDocumentTotal(personal.total ?? personal.data.length);
        setTotals((personal as AnyRecord).totals ?? {});
        setDocuments([]);
        setRequirements([]);
        setAcknowledgements([]);
        setMembers([]);
        setGroups([]);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [acknowledgementOffset, canReadAll, documentOffset, requirementOffset, search]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timeout);
  }, [load]);

  useEffect(() => {
    if (drawer?.type !== "requirement" && drawer?.type !== "acknowledge-behalf") return;
    const timeout = window.setTimeout(() => {
      void Promise.all([
        api.memberProfilesPage({ status: "Active", search: memberLookup || undefined, limit: 50, offset: 0 }),
        api.groupsPage({ status: "Active", search: groupLookup || undefined, limit: 50, offset: 0 }),
      ]).then(([memberResult, groupResult]) => {
        const selectedMember = drawer.type === "requirement" ? drawer.requirement?.target?.member : drawer.requirement.target?.member;
        const selectedGroup = drawer.type === "requirement" ? drawer.requirement?.target?.group : drawer.requirement.target?.group;
        const nextMembers = memberResult.data as MemberOption[];
        const nextGroups = groupResult.data as GroupOption[];
        setMembers(selectedMember && !nextMembers.some((member) => member.id === selectedMember.id) ? [selectedMember, ...nextMembers] : nextMembers);
        setGroups(selectedGroup && !nextGroups.some((group) => group.id === selectedGroup.id) ? [selectedGroup, ...nextGroups] : nextGroups);
      }).catch((err) => setDrawerError(errorMessage(err)));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [drawer?.type, groupLookup, memberLookup]);

  const reloadAfter = async (message: string) => {
    await load();
    setSuccess(message);
  };

  const openDocumentDrawer = (mode: "create" | "edit", document?: DocumentSummary) => {
    const next = documentFormFrom(document);
    setDocumentForm(next);
    setDocumentBaseline(next);
    setDrawerError("");
    setDrawer({ type: "document", mode, document });
  };

  const openVersionList = async (document: DocumentSummary) => {
    setDrawerError("");
    setVersionRows([]);
    setDrawer({ type: "versions", document });
    try {
      const list = await api.documentVersions(document.id);
      setVersionRows(list.data as DocumentVersion[]);
    } catch (err) {
      setDrawerError(errorMessage(err));
    }
  };

  const openVersionDrawer = async (mode: "create" | "edit", documentId: string, version?: DocumentVersion) => {
    let hydratedVersion = version;
    if (mode === "edit" && version) {
      try {
        hydratedVersion = await api.documentVersionContent(version.id) as DocumentVersion;
      } catch {
        hydratedVersion = version;
      }
    }
    const next = versionFormFrom(hydratedVersion);
    setVersionForm(next);
    setVersionBaseline(next);
    setDrawerError("");
    setDrawer({ type: "version", mode, documentId, version: hydratedVersion });
  };

  const openRequirementDrawer = (mode: "create" | "edit", requirement?: DocumentRequirement) => {
    const next = requirementFormFrom(
      requirement,
      publishedVersionOptions[0]?.id ?? "",
      groups.find((group) => group.status !== "Archived")?.id ?? "",
      members.find((member) => member.status !== "Archived")?.id ?? ""
    );
    setRequirementForm(next);
    setRequirementBaseline(next);
    setMemberLookup("");
    setGroupLookup("");
    setDrawerError("");
    if (requirement?.target?.member && !members.some((member) => member.id === requirement.target!.member!.id)) setMembers((current) => [requirement.target!.member!, ...current]);
    if (requirement?.target?.group && !groups.some((group) => group.id === requirement.target!.group!.id)) setGroups((current) => [requirement.target!.group!, ...current]);
    setDrawer({ type: "requirement", mode, requirement });
  };

  const openOnBehalfDrawer = (requirement: DocumentRequirement) => {
    const selected = requirement.targetType === "MemberProfile" ? requirement.memberProfileId ?? "" : "";
    if (requirement.target?.member && !members.some((member) => member.id === requirement.target!.member!.id)) setMembers((current) => [requirement.target!.member!, ...current]);
    setBehalfForm({ memberProfileId: selected, note: "" });
    setMemberLookup("");
    setDrawerError("");
    setDrawer({ type: "acknowledge-behalf", requirement });
  };

  const openContent = async (versionId: string, title: string, obligation?: PersonalDocument) => {
    setContentRecord(null);
    setDrawerError("");
    setDrawer({ type: "content", title, obligation });
    try {
      setContentRecord(await api.documentVersionContent(versionId));
    } catch (err) {
      setDrawerError(errorMessage(err));
    }
  };

  const saveDocument = async () => {
    if (drawer?.type !== "document") return;
    setSaving(true);
    setDrawerError("");
    try {
      if (drawer.mode === "edit" && drawer.document) {
        await api.updateDocument(drawer.document.id, { ...documentForm, expectedVersion: drawer.document.version });
        setDrawer(null);
        await reloadAfter("Document updated");
      } else {
        await api.createDocument(documentForm);
        setDrawer(null);
        await reloadAfter("Document created");
      }
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleDocumentActive = async (document: DocumentSummary) => {
    setSaving(true);
    setDrawerError("");
    try {
      if (document.active) await api.archiveDocument(document.id, { expectedVersion: document.version });
      else await api.reactivateDocument(document.id, { expectedVersion: document.version });
      setDrawer(null);
      await reloadAfter(document.active ? "Document archived" : "Document updated");
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const saveVersion = async () => {
    if (drawer?.type !== "version") return;
    setSaving(true);
    setDrawerError("");
    try {
      const body = {
        ...versionForm,
        contentBody: versionForm.contentMode === "Internal text" ? versionForm.contentBody : "",
        externalUrl: versionForm.contentMode === "External link" ? versionForm.externalUrl : ""
      };
      if (drawer.mode === "edit" && drawer.version) {
        await api.updateDocumentVersion(drawer.version.id, { ...body, expectedVersion: drawer.version.version });
        setDrawer(null);
        await reloadAfter("Document version updated");
      } else {
        const created = await api.createDocumentVersion(drawer.documentId, body);
        setDrawer({ type: "versions", document: documents.find((document) => document.id === drawer.documentId)! });
        const list = await api.documentVersions(drawer.documentId);
        setVersionRows(list.data as DocumentVersion[]);
        setSuccess(`Version ${created.versionLabel} created`);
      }
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const publishVersion = async (version: DocumentVersion) => {
    const document = documents.find((item) => item.id === version.documentId);
    const current = document?.currentVersion;
    const confirmed = window.confirm([
      `Publish ${version.versionLabel}?`,
      `Current published version: ${current?.versionLabel ?? "None"}`,
      `Active requirements: ${current?.requirementCount ?? document?.activeRequirementCount ?? 0}`,
      `Acknowledgements: ${current?.acknowledgementCount ?? document?.acknowledgementCount ?? 0}`,
      `Outstanding acknowledgements: ${current?.outstandingCount ?? document?.outstandingCount ?? 0}`,
      "Requirements do not automatically carry forward to the new version.",
    ].join("\n\n"));
    if (!confirmed) return;
    setSaving(true);
    setDrawerError("");
    try {
      await api.publishDocumentVersion(version.id, { expectedVersion: version.version, operationId: crypto.randomUUID(), expectedCurrentPublishedVersionId: current?.id ?? null });
      if (document) {
        const list = await api.documentVersions(document.id);
        setVersionRows(list.data as DocumentVersion[]);
      }
      await reloadAfter("Document version published");
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const withdrawVersion = async (version: DocumentVersion) => {
    const reason = version.status === "Published" ? window.prompt("Reason for withdrawing this published version:")?.trim() : "Draft withdrawn";
    if (version.status === "Published" && (!reason || reason.length < 3)) return;
    setSaving(true);
    setDrawerError("");
    try {
      await api.withdrawDocumentVersion(version.id, { expectedVersion: version.version, operationId: crypto.randomUUID(), reason });
      const list = await api.documentVersions(version.documentId);
      setVersionRows(list.data as DocumentVersion[]);
      await reloadAfter("Document version withdrawn");
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const saveRequirement = async () => {
    if (drawer?.type !== "requirement") return;
    setSaving(true);
    setDrawerError("");
    try {
      const body = {
        ...requirementForm,
        targetRole: requirementForm.targetType === "Role" ? requirementForm.targetRole : "",
        groupId: requirementForm.targetType === "Group" ? requirementForm.groupId : "",
        memberProfileId: requirementForm.targetType === "MemberProfile" ? requirementForm.memberProfileId : ""
      };
      if (drawer.mode === "edit" && drawer.requirement) {
        await api.updateDocumentRequirement(drawer.requirement.id, { ...body, expectedVersion: drawer.requirement.recordVersion });
        setDrawer(null);
        await reloadAfter("Document requirement updated");
      } else {
        await api.createDocumentRequirement(body);
        setDrawer(null);
        await reloadAfter("Document requirement created");
      }
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const endRequirement = async (requirement: DocumentRequirement) => {
    setSaving(true);
    setDrawerError("");
    try {
      await api.endDocumentRequirement(requirement.id, { expectedVersion: requirement.recordVersion, operationId: crypto.randomUUID() });
      setDrawer(null);
      await reloadAfter("Document requirement ended");
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const acknowledge = async (obligation: PersonalDocument) => {
    setSaving(true);
    setDrawerError("");
    try {
      await api.acknowledgeDocumentVersion(obligation.documentVersionId, { operationId: crypto.randomUUID() });
      setDrawer(null);
      await reloadAfter("Document acknowledged");
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const acknowledgeOnBehalf = async () => {
    if (drawer?.type !== "acknowledge-behalf") return;
    setSaving(true);
    setDrawerError("");
    try {
      await api.acknowledgeDocumentVersion(drawer.requirement.documentVersionId, { operationId: crypto.randomUUID(), memberProfileId: behalfForm.memberProfileId, onBehalf: true, note: behalfForm.note });
      setDrawer(null);
      await reloadAfter("Document acknowledged on behalf of member");
    } catch (err) {
      setDrawerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const totalOutstanding = canReadAll
    ? Number(totals.outstanding ?? 0)
    : Number(totals.outstanding ?? 0);

  return (
    <>
      <PageIntro
        eyebrow="Operational documentation"
        title="Documents"
        description={canReadAll ? "Manage published guidance, version history and required acknowledgements." : "Read and acknowledge the documents required for your current role, group or profile."}
      />

      <div className="grid gap-4">
        {success ? <AlertBox tone="success" dismissible>{success}</AlertBox> : null}
        {error ? <AlertBox tone="danger">{error}</AlertBox> : null}

        {loading ? (
          <Card><div className="p-5"><Loading label="Loading documents" /></div></Card>
        ) : canReadAll ? (
          <>
            <div className="grid gap-3 md:grid-cols-4">
              <Card><div className="p-4"><p className="text-xs font-black uppercase text-muted-foreground">Documents</p><p className="mt-2 text-3xl font-black">{totals.documents ?? documentTotal}</p></div></Card>
              <Card><div className="p-4"><p className="text-xs font-black uppercase text-muted-foreground">Published</p><p className="mt-2 text-3xl font-black">{totals.published ?? 0}</p></div></Card>
              <Card><div className="p-4"><p className="text-xs font-black uppercase text-muted-foreground">Requirements</p><p className="mt-2 text-3xl font-black">{totals.requirements ?? requirementTotal}</p></div></Card>
              <Card><div className="p-4"><p className="text-xs font-black uppercase text-muted-foreground">To acknowledge</p><p className="mt-2 text-3xl font-black">{totalOutstanding}</p></div></Card>
            </div>

            <Card>
              <CardHeader
                title="Document library"
                description="Open the current published version, or manage drafts and historical versions."
                action={canManageDocuments ? <Button variant="create" icon={Plus} onClick={() => openDocumentDrawer("create")}>New document</Button> : null}
              />
              <div className="grid gap-4 p-4">
                <Field label="Search documents"><Input aria-label="Search documents" value={search} placeholder="Title, code, category, owner" onChange={(event) => { setDocumentOffset(0); setSearch(event.target.value); }} /></Field>
                <Table
                  rows={filteredDocuments}
                  minWidth="min-w-[1000px] w-full"
                  emptyTitle="No documents found"
                  emptyDetail="Documents created here will appear in this list."
                  rowAction={(row) => {
                    const document = row as DocumentSummary;
                    return (
                      <div className="flex flex-wrap justify-end gap-2">
                        {document.currentVersion ? <Button size="sm" variant="secondary" icon={BookOpenCheck} onClick={() => openContent(document.currentVersion!.id, document.title)}>Read</Button> : null}
                        <Button size="sm" variant="secondary" icon={Layers3} onClick={() => void openVersionList(document)}>Versions</Button>
                        {canManageDocuments ? <Button size="sm" variant="secondary" icon={Edit3} onClick={() => openDocumentDrawer("edit", document)}>Edit</Button> : null}
                      </div>
                    );
                  }}
                  actionWidth="w-72"
                  columns={[
                    { key: "title", label: "Document", render: (row) => <div><p className="font-black">{(row as DocumentSummary).title}</p><p className="text-xs font-bold text-muted-foreground">{(row as DocumentSummary).code} · {(row as DocumentSummary).category}</p></div> },
                    { key: "currentVersion", label: "Current version", render: (row) => (row as DocumentSummary).currentVersion ? <StatusBadge value={(row as DocumentSummary).currentVersion!.versionLabel} /> : <StatusBadge value="No published version" /> },
                    { key: "ownerFunction", label: "Owner" },
                    { key: "activeRequirementCount", label: "Requirements", render: (row) => String((row as DocumentSummary).activeRequirementCount ?? 0) },
                    { key: "outstandingCount", label: "To acknowledge", render: (row) => String((row as DocumentSummary).outstandingCount ?? 0) },
                    { key: "status", label: "State", render: (row) => <StatusBadge value={(row as DocumentSummary).status} /> }
                  ]}
                />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-muted-foreground">{documentTotal ? documentOffset + 1 : 0}–{Math.min(documentOffset + documents.length, documentTotal)} of {documentTotal}</span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" disabled={documentOffset === 0 || loading} onClick={() => setDocumentOffset((value) => Math.max(0, value - pageSize))}>Previous</Button>
                    <Button size="sm" variant="secondary" disabled={documentOffset + pageSize >= documentTotal || loading} onClick={() => setDocumentOffset((value) => value + pageSize)}>Next</Button>
                  </div>
                </div>
              </div>
            </Card>

            <div className="grid gap-4 xl:grid-cols-2">
              <Card>
                <CardHeader
                  title="Requirements"
                  description="Requirements are ongoing rules for roles, groups or individual member profiles."
                  action={canManageRequirements ? <Button variant="create" icon={Plus} onClick={() => openRequirementDrawer("create")}>New requirement</Button> : null}
                />
                <div className="p-4">
                  <Table
                    rows={requirements}
                    minWidth="min-w-[820px] w-full"
                    emptyTitle="No document requirements found"
                    emptyDetail="Required documents will appear here when they are assigned."
                    rowAction={(row) => { const requirement = row as DocumentRequirement; return <div className="flex flex-wrap justify-end gap-2">{canAcknowledgeAll && requirement.active && requirement.acknowledgementRequired ? <Button size="sm" variant="create" icon={CheckCircle2} onClick={() => openOnBehalfDrawer(requirement)}>Acknowledge on behalf</Button> : null}{canManageRequirements ? <Button size="sm" variant="secondary" icon={Edit3} onClick={() => openRequirementDrawer("edit", requirement)}>Edit</Button> : null}</div>; }}
                    actionWidth="w-64"
                    columns={[
                      { key: "document", label: "Document", render: (row) => <div><p className="font-black">{(row as DocumentRequirement).document.title}</p><p className="text-xs font-bold text-muted-foreground">{(row as DocumentRequirement).version.versionLabel}</p></div> },
                      { key: "targetLabel", label: "Target", render: (row) => `${(row as DocumentRequirement).targetType}: ${(row as DocumentRequirement).targetLabel}` },
                      { key: "dueAt", label: "Due", render: (row) => formatDateTime((row as DocumentRequirement).dueAt) },
                      { key: "active", label: "State", render: (row) => <StatusBadge value={(row as DocumentRequirement).active ? "Active" : "Ended"} /> }
                    ]}
                  />
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-sm font-bold text-muted-foreground">{requirementTotal ? requirementOffset + 1 : 0}–{Math.min(requirementOffset + requirements.length, requirementTotal)} of {requirementTotal}</span>
                    <div className="flex gap-2"><Button size="sm" variant="secondary" disabled={requirementOffset === 0 || loading} onClick={() => setRequirementOffset((value) => Math.max(0, value - pageSize))}>Previous</Button><Button size="sm" variant="secondary" disabled={requirementOffset + pageSize >= requirementTotal || loading} onClick={() => setRequirementOffset((value) => value + pageSize)}>Next</Button></div>
                  </div>
                </div>
              </Card>

              <Card>
                <CardHeader title="Acknowledgements" description="Immutable acknowledgements for specific published versions." />
                <div className="p-4">
                  <Table
                    rows={acknowledgements}
                    minWidth="min-w-[760px] w-full"
                    emptyTitle="No acknowledgements found"
                    emptyDetail="Acknowledgements will appear here after members confirm required documents."
                    columns={[
                      { key: "member", label: "Member", render: (row) => (row as AnyRecord).member?.displayName ?? "" },
                      { key: "document", label: "Document", render: (row) => <div><p className="font-black">{(row as AnyRecord).document?.title}</p><p className="text-xs font-bold text-muted-foreground">{(row as AnyRecord).version?.versionLabel}</p></div> },
                      { key: "acknowledgedAt", label: "Acknowledged", render: (row) => formatDateTime((row as AnyRecord).acknowledgedAt) },
                      { key: "onBehalf", label: "Mode / evidence", render: (row) => { const acknowledgement = row as AnyRecord; return <div><p className="font-bold">{acknowledgement.onBehalf ? `On behalf · actor ${acknowledgement.acknowledgedById}` : "Self acknowledgement"}</p><p className="text-xs font-bold text-muted-foreground">{acknowledgement.legacyImported ? "Legacy evidence unavailable" : `Sources: ${acknowledgement.sourceRequirementIds?.join(", ") || "None"}`}</p></div>; } }
                    ]}
                  />
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-sm font-bold text-muted-foreground">{acknowledgementTotal ? acknowledgementOffset + 1 : 0}–{Math.min(acknowledgementOffset + acknowledgements.length, acknowledgementTotal)} of {acknowledgementTotal}</span>
                    <div className="flex gap-2"><Button size="sm" variant="secondary" disabled={acknowledgementOffset === 0 || loading} onClick={() => setAcknowledgementOffset((value) => Math.max(0, value - pageSize))}>Previous</Button><Button size="sm" variant="secondary" disabled={acknowledgementOffset + pageSize >= acknowledgementTotal || loading} onClick={() => setAcknowledgementOffset((value) => value + pageSize)}>Next</Button></div>
                  </div>
                </div>
              </Card>
            </div>
          </>
        ) : (
          <Card>
            <CardHeader
              title="My documents"
              description={linkedMember ? `${linkedMember.displayName} · ${linkedMember.memberId}` : "Your linked member profile controls this list."}
            />
            <div className="grid gap-4 p-4">
              <Field label="Search my documents"><Input aria-label="Search my documents" value={search} placeholder="Title, code, category" onChange={(event) => { setDocumentOffset(0); setSearch(event.target.value); }} /></Field>
              {!linkedMember ? (
                <EmptyState title="No linked member profile" detail="Ask a coordinator to link your account before personal documents appear." />
              ) : filteredPersonalDocuments.length ? (
                <div className="grid gap-3">
                  {filteredPersonalDocuments.map((document) => (
                    <div key={document.id} className="rounded-lg border border-border bg-card p-4">
                      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusBadge value={document.status} />
                            <Badge tone="neutral">{document.versionLabel}</Badge>
                            <Badge tone="info">{document.contentMode}</Badge>
                          </div>
                          <h2 className="mt-3 text-lg font-black text-foreground">{document.title}</h2>
                          <p className="mt-1 text-sm font-semibold text-muted-foreground">{document.code} · {document.category}</p>
                          <p className="mt-2 text-sm text-muted-foreground">{document.description}</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {document.reasons.map((reason) => <Badge key={reason.id} tone="info">{reason.label}</Badge>)}
                            <Badge tone="neutral">Due: {formatDateTime(document.dueAt)}</Badge>
                            {document.acknowledgedAt ? <Badge tone="success">Acknowledged: {formatDateTime(document.acknowledgedAt)}</Badge> : null}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2 lg:justify-end">
                          <Button variant="secondary" icon={BookOpenCheck} onClick={() => openContent(document.documentVersionId, document.title, document)}>Read</Button>
                          {document.canAcknowledge ? <Button variant="create" icon={CheckCircle2} disabled={saving} onClick={() => void acknowledge(document)}>Acknowledge</Button> : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title="No documents assigned" detail="Required documents will appear here when they are assigned to your profile, group or role." />
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-bold text-muted-foreground">{documentTotal ? documentOffset + 1 : 0}–{Math.min(documentOffset + personalDocuments.length, documentTotal)} of {documentTotal}</span>
                <div className="flex gap-2"><Button size="sm" variant="secondary" disabled={documentOffset === 0 || loading} onClick={() => setDocumentOffset((value) => Math.max(0, value - pageSize))}>Previous</Button><Button size="sm" variant="secondary" disabled={documentOffset + pageSize >= documentTotal || loading} onClick={() => setDocumentOffset((value) => value + pageSize)}>Next</Button></div>
              </div>
            </div>
          </Card>
        )}
      </div>

      {drawer?.type === "content" ? (
        <DialogSurface
          title="Document content"
          onClose={() => setDrawer(null)}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          <div className="border-b border-border p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 data-dialog-heading="true" tabIndex={-1} className="text-xl font-black text-foreground">{drawer.title}</h2>
                {contentRecord ? <p className="mt-1 text-sm font-semibold text-muted-foreground">{contentRecord.versionLabel} · {contentRecord.contentMode}</p> : null}
              </div>
              <Button variant="ghost" onClick={() => setDrawer(null)}>Close</Button>
            </div>
          </div>
          <div className="scrollbar-soft grid flex-1 content-start gap-4 overflow-y-auto p-5">
            <ErrorSummary title="Document could not be opened" errors={drawerError ? [{ message: drawerError }] : []} />
            {!contentRecord && !drawerError ? <Loading label="Loading document" /> : null}
            {contentRecord?.contentMode === "Internal text" ? (
              <div className="whitespace-pre-wrap rounded-lg border border-border bg-muted p-4 text-sm font-semibold leading-7 text-foreground">{contentRecord.contentBody}</div>
            ) : contentRecord?.externalUrl ? (
              <a className="focus-ring inline-flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm font-black text-foreground hover:bg-card" href={contentRecord.externalUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
                Open external document
              </a>
            ) : null}
          </div>
          {drawer.obligation?.canAcknowledge ? (
            <div className="border-t border-border bg-card p-4">
              <Button variant="create" icon={CheckCircle2} disabled={saving} className="w-full" onClick={() => void acknowledge(drawer.obligation!)}>{saving ? "Saving..." : "Acknowledge"}</Button>
            </div>
          ) : null}
        </DialogSurface>
      ) : null}

      {drawer?.type === "document" ? (
        <DialogSurface
          title={drawer.mode === "create" ? "New document" : "Edit document"}
          onClose={() => setDrawer(null)}
          busy={saving}
          dirty={JSON.stringify(documentForm) !== JSON.stringify(documentBaseline)}
          initialFocus="first-control"
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void saveDocument(); }}>
            <div className="border-b border-border p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 data-dialog-heading="true" tabIndex={-1} className="text-xl font-black text-foreground">{drawer.mode === "create" ? "New document" : "Edit document"}</h2>
                  <p className="mt-1 text-sm font-semibold text-muted-foreground">Use a clear title and stable code for the document.</p>
                </div>
                <Button variant="ghost" type="button" onClick={() => setDrawer(null)}>Close</Button>
              </div>
            </div>
            <div className="scrollbar-soft grid flex-1 content-start gap-4 overflow-y-auto p-5">
              <ErrorSummary title="Document could not be saved" errors={drawerError ? [{ message: drawerError }] : []} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Code" required><Input data-dialog-initial-focus="true" value={documentForm.code} onChange={(event) => setDocumentForm((form) => ({ ...form, code: event.target.value }))} /></Field>
                <Field label="Title" required><Input value={documentForm.title} onChange={(event) => setDocumentForm((form) => ({ ...form, title: event.target.value }))} /></Field>
                <Field label="Category"><Input value={documentForm.category} onChange={(event) => setDocumentForm((form) => ({ ...form, category: event.target.value }))} /></Field>
                <Field label="Owner function"><Input value={documentForm.ownerFunction} onChange={(event) => setDocumentForm((form) => ({ ...form, ownerFunction: event.target.value }))} /></Field>
              </div>
              <Field label="Description"><Textarea value={documentForm.description} onChange={(event) => setDocumentForm((form) => ({ ...form, description: event.target.value }))} /></Field>
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-border bg-card p-4 sm:flex-row sm:justify-between">
              {drawer.mode === "edit" && drawer.document ? (
                <Button type="button" variant={drawer.document.active ? "warning" : "success"} disabled={saving} onClick={() => void toggleDocumentActive(drawer.document!)}>
                  {drawer.document.active ? "Archive document" : "Reactivate document"}
                </Button>
              ) : <span />}
              <Button type="submit" variant="create" icon={CheckCircle2} disabled={saving}>{saving ? "Saving..." : "Save document"}</Button>
            </div>
          </form>
        </DialogSurface>
      ) : null}

      {drawer?.type === "versions" ? (
        <DialogSurface
          title="Document versions"
          onClose={() => setDrawer(null)}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-3xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          <div className="border-b border-border p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 data-dialog-heading="true" tabIndex={-1} className="text-xl font-black text-foreground">{drawer.document.title}</h2>
                <p className="mt-1 text-sm font-semibold text-muted-foreground">Version history and draft controls.</p>
              </div>
              <div className="flex gap-2">
                {canManageVersions ? <Button variant="create" icon={Plus} onClick={() => void openVersionDrawer("create", drawer.document.id)}>New version</Button> : null}
                <Button variant="ghost" onClick={() => setDrawer(null)}>Close</Button>
              </div>
            </div>
          </div>
          <div className="scrollbar-soft grid flex-1 content-start gap-4 overflow-y-auto p-5">
            <ErrorSummary title="Version action could not be completed" errors={drawerError ? [{ message: drawerError }] : []} />
            <Table
              rows={versionRows}
              minWidth="min-w-[820px] w-full"
              emptyTitle="No versions found"
              emptyDetail="Create a draft version before publishing this document."
              rowAction={(row) => {
                const version = row as DocumentVersion;
                return (
                  <div className="flex flex-wrap justify-end gap-2">
                    {version.contentAvailable ? <Button size="sm" variant="secondary" icon={BookOpenCheck} onClick={() => openContent(version.id, drawer.document.title)}>Read</Button> : null}
                    {canManageVersions && version.status === "Draft" ? <Button size="sm" variant="secondary" icon={Edit3} onClick={() => void openVersionDrawer("edit", drawer.document.id, version)}>Edit</Button> : null}
                    {canPublish && version.status === "Draft" ? <Button size="sm" variant="create" icon={ShieldCheck} disabled={saving || !version.contentAvailable} onClick={() => void publishVersion(version)}>Publish</Button> : null}
                    {canPublish && (version.status === "Draft" || version.status === "Published") ? <Button size="sm" variant="warning" icon={XCircle} disabled={saving} onClick={() => void withdrawVersion(version)}>Withdraw</Button> : null}
                  </div>
                );
              }}
              actionWidth="w-80"
              columns={[
                { key: "versionLabel", label: "Version", render: (row) => <div><p className="font-black">{(row as DocumentVersion).versionLabel}</p><p className="text-xs font-bold text-muted-foreground">{(row as DocumentVersion).changeSummary || "No summary"}</p></div> },
                { key: "status", label: "State", render: (row) => <StatusBadge value={(row as DocumentVersion).status} /> },
                { key: "contentMode", label: "Content" },
                { key: "publishedAt", label: "Published / withdrawn", render: (row) => { const version = row as DocumentVersion; return <div><p>{version.publishedAt ? `${formatDateTime(version.publishedAt)} · ${version.publishedById ?? "actor unavailable"}` : "Not published"}</p>{version.withdrawnAt ? <p className="text-xs font-bold text-muted-foreground">Withdrawn {formatDateTime(version.withdrawnAt)} · {version.withdrawnById ?? "actor unavailable"}{version.withdrawReason ? ` · ${version.withdrawReason}` : ""}</p> : null}</div>; } },
                { key: "reviewDueAt", label: "Review due", render: (row) => formatDateTime((row as DocumentVersion).reviewDueAt) }
              ]}
            />
          </div>
        </DialogSurface>
      ) : null}

      {drawer?.type === "version" ? (
        <DialogSurface
          title={drawer.mode === "create" ? "New document version" : "Edit document version"}
          onClose={() => setDrawer(null)}
          busy={saving}
          dirty={JSON.stringify(versionForm) !== JSON.stringify(versionBaseline)}
          initialFocus="first-control"
          className="fixed inset-y-0 right-0 z-[60] flex w-full max-w-2xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void saveVersion(); }}>
            <div className="border-b border-border p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 data-dialog-heading="true" tabIndex={-1} className="text-xl font-black text-foreground">{drawer.mode === "create" ? "New document version" : "Edit document version"}</h2>
                  <p className="mt-1 text-sm font-semibold text-muted-foreground">Draft content can be changed until it is published.</p>
                </div>
                <Button variant="ghost" type="button" onClick={() => setDrawer(null)}>Close</Button>
              </div>
            </div>
            <div className="scrollbar-soft grid flex-1 content-start gap-4 overflow-y-auto p-5">
              <ErrorSummary title="Version could not be saved" errors={drawerError ? [{ message: drawerError }] : []} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Version label" required><Input data-dialog-initial-focus="true" value={versionForm.versionLabel} onChange={(event) => setVersionForm((form) => ({ ...form, versionLabel: event.target.value }))} /></Field>
                <Field label="Content mode">
                  <Select value={versionForm.contentMode} onChange={(event) => setVersionForm((form) => ({ ...form, contentMode: event.target.value }))}>
                    {contentModes.map((mode) => <option key={mode}>{mode}</option>)}
                  </Select>
                </Field>
                <Field label="Effective from"><Input type="datetime-local" value={versionForm.effectiveFrom} onChange={(event) => setVersionForm((form) => ({ ...form, effectiveFrom: event.target.value }))} /></Field>
                <Field label="Review due"><Input type="datetime-local" value={versionForm.reviewDueAt} onChange={(event) => setVersionForm((form) => ({ ...form, reviewDueAt: event.target.value }))} /></Field>
              </div>
              <Field label="Change summary"><Input value={versionForm.changeSummary} onChange={(event) => setVersionForm((form) => ({ ...form, changeSummary: event.target.value }))} /></Field>
              {versionForm.contentMode === "Internal text" ? (
                <Field label="Content" required><Textarea className="min-h-48" value={versionForm.contentBody} onChange={(event) => setVersionForm((form) => ({ ...form, contentBody: event.target.value }))} /></Field>
              ) : (
                <Field label="External link" required><Input type="url" inputMode="url" value={versionForm.externalUrl} onChange={(event) => setVersionForm((form) => ({ ...form, externalUrl: event.target.value }))} /></Field>
              )}
            </div>
            <div className="border-t border-border bg-card p-4">
              <Button type="submit" variant="create" icon={CheckCircle2} disabled={saving} className="w-full">{saving ? "Saving..." : "Save version"}</Button>
            </div>
          </form>
        </DialogSurface>
      ) : null}

      {drawer?.type === "requirement" ? (
        <DialogSurface
          title={drawer.mode === "create" ? "New document requirement" : "Edit document requirement"}
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
                  <h2 data-dialog-heading="true" tabIndex={-1} className="text-xl font-black text-foreground">{drawer.mode === "create" ? "New document requirement" : "Edit document requirement"}</h2>
                  <p className="mt-1 text-sm font-semibold text-muted-foreground">Choose one target for this published document version.</p>
                </div>
                <Button variant="ghost" type="button" onClick={() => setDrawer(null)}>Close</Button>
              </div>
            </div>
            <div className="scrollbar-soft grid flex-1 content-start gap-4 overflow-y-auto p-5">
              <ErrorSummary title="Requirement could not be saved" errors={drawerError ? [{ message: drawerError }] : []} />
              <Field label="Published version" required>
                <Select data-dialog-initial-focus="true" value={requirementForm.documentVersionId} onChange={(event) => setRequirementForm((form) => ({ ...form, documentVersionId: event.target.value }))}>
                  <option value="">Select version</option>
                  {publishedVersionOptions.map((version) => <option key={version.id} value={version.id}>{version.documentTitle} · {version.versionLabel}</option>)}
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Target type" required>
                  <Select value={requirementForm.targetType} onChange={(event) => setRequirementForm((form) => ({ ...form, targetType: event.target.value }))}>
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
                  <div className="grid content-start gap-3">
                    <Field label="Find group"><Input aria-label="Search groups" value={groupLookup} placeholder="Search groups" onChange={(event) => setGroupLookup(event.target.value)} /></Field>
                    <Field label="Group" required><Select value={requirementForm.groupId} onChange={(event) => setRequirementForm((form) => ({ ...form, groupId: event.target.value }))}>
                        <option value="">Select group</option>
                        {groups.map((group) => <option key={group.id} value={group.id}>{group.name} · {group.memberCount ?? 0} members</option>)}
                      </Select></Field>
                  </div>
                ) : (
                  <div className="grid content-start gap-3">
                    <Field label="Find member"><Input aria-label="Search members" value={memberLookup} placeholder="Search members" onChange={(event) => setMemberLookup(event.target.value)} /></Field>
                    <Field label="Member" required><Select value={requirementForm.memberProfileId} onChange={(event) => setRequirementForm((form) => ({ ...form, memberProfileId: event.target.value }))}>
                        <option value="">Select member</option>
                        {members.map((member) => <option key={member.id} value={member.id}>{member.displayName} · {member.memberId}</option>)}
                      </Select></Field>
                  </div>
                )}
                <Field label="Due"><Input type="datetime-local" value={requirementForm.dueAt} onChange={(event) => setRequirementForm((form) => ({ ...form, dueAt: event.target.value }))} /></Field>
                <label className="flex items-center gap-2 self-end rounded-md border border-border bg-muted px-3 py-2 text-sm font-bold text-foreground">
                  <input type="checkbox" checked={requirementForm.acknowledgementRequired} onChange={(event) => setRequirementForm((form) => ({ ...form, acknowledgementRequired: event.target.checked }))} />
                  Acknowledgement required
                </label>
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

      {drawer?.type === "acknowledge-behalf" ? (
        <DialogSurface
          title="Acknowledge on behalf"
          onClose={() => setDrawer(null)}
          busy={saving}
          dirty={Boolean(behalfForm.memberProfileId || behalfForm.note)}
          initialFocus="first-control"
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void acknowledgeOnBehalf(); }}>
            <div className="border-b border-border p-5">
              <div className="flex items-start justify-between gap-3">
                <div><h2 data-dialog-heading="true" tabIndex={-1} className="text-xl font-black text-foreground">Acknowledge on behalf</h2><p className="mt-1 text-sm font-semibold text-muted-foreground">{drawer.requirement.document.title} · {drawer.requirement.version.versionLabel}</p></div>
                <Button variant="ghost" type="button" onClick={() => setDrawer(null)}>Close</Button>
              </div>
            </div>
            <div className="scrollbar-soft grid flex-1 content-start gap-4 overflow-y-auto p-5">
              <AlertBox tone="warning">This records the authenticated actor separately from the member and cannot be edited or deleted.</AlertBox>
              <ErrorSummary title="Acknowledgement could not be recorded" errors={drawerError ? [{ message: drawerError }] : []} />
              <Field label="Find member"><Input data-dialog-initial-focus="true" aria-label="Search members for acknowledgement" value={memberLookup} placeholder="Name or member ID" onChange={(event) => setMemberLookup(event.target.value)} /></Field>
              <Field label="Member" required><Select value={behalfForm.memberProfileId} onChange={(event) => setBehalfForm((form) => ({ ...form, memberProfileId: event.target.value }))}><option value="">Select member</option>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName} · {member.memberId}</option>)}</Select></Field>
              <Field label="Reason / note" required><Textarea value={behalfForm.note} onChange={(event) => setBehalfForm((form) => ({ ...form, note: event.target.value }))} /></Field>
            </div>
            <div className="border-t border-border bg-card p-4"><Button type="submit" variant="create" icon={CheckCircle2} disabled={saving || !behalfForm.memberProfileId || behalfForm.note.trim().length < 3} className="w-full">{saving ? "Saving..." : "Record acknowledgement"}</Button></div>
          </form>
        </DialogSurface>
      ) : null}
    </>
  );
}

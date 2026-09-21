import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Permission } from "@zpp/shared";
import { HttpError } from "../../errors.js";
import { EffectiveAccessService } from "../identity/effective-access-service.js";
import { renderAarPdf, type AarPdfView } from "./aar-pdf-renderer.js";
import {
  aarPdfLimit, artifactSelect, canonicalJson, contentDigest, createSchema, editSchema,
  commandSchema, archiveSchema, listSchema, pageSchema, sha256, uuid, versionInclude,
  type AarActor, type AarPage, type AarVersion,
} from "./after-action-report-types.js";

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;
type Target = "report" | "version" | "artifact";
type Result = { reportId: string; reportVersionId?: string; artifactId?: string; version: number; status: string };
type Hooks = {
  afterSessionLock?: () => void | Promise<void>;
  beforeAudit?: () => void | Promise<void>;
  beforeArtifactInsert?: () => void | Promise<void>;
  render?: (view: AarPdfView) => Promise<Buffer>;
};
const absent = () => new HttpError(404, "After Action Report resource not found");
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function expectVersion(actual: number, expected: number) {
  if (actual !== expected) throw new HttpError(409, "Report has changed. Reload and review before saving.");
}
const reportInclude = { session: true, owner: { select: { id: true, displayName: true } } } as const;
type Report = Prisma.AfterActionReportGetPayload<{ include: typeof reportInclude }>;

export function createPrismaAfterActionReportService(client: PrismaClient, hooks: Hooks = {}) {
  async function authorize(db: Db, sessionId: string, actor: AarActor, required: Permission[], hidden = true) {
    const permissions = await new EffectiveAccessService(db).effectivePermissionsForUser(actor.id, { incidentId: sessionId });
    if (!["session:read", ...required].every(p => permissions.includes(p as Permission))) {
      throw hidden ? absent() : new HttpError(403, "Forbidden");
    }
    return permissions;
  }
  async function context(kind: Target, id: string, db: Db = client) {
    if (!uuid.safeParse(id).success) throw absent();
    let reportId: string | undefined;
    let reportVersionId: string | undefined;
    if (kind === "report") reportId = id;
    if (kind === "version") {
      const v = await db.afterActionReportVersion.findUnique({ where: { id }, select: { reportId: true } });
      reportId = v?.reportId; reportVersionId = id;
    }
    if (kind === "artifact") {
      const a = await db.afterActionPdfArtifact.findUnique({ where: { id }, select: { reportVersionId: true, reportVersion: { select: { reportId: true } } } });
      reportId = a?.reportVersion.reportId; reportVersionId = a?.reportVersionId;
    }
    if (!reportId) throw absent();
    const report = await db.afterActionReport.findUnique({ where: { id: reportId }, select: { sessionId: true } });
    if (!report) throw absent();
    return { reportId, reportVersionId, sessionId: report.sessionId };
  }
  async function lockSession(tx: Tx, sessionId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Session" WHERE "id"=${sessionId}::uuid FOR UPDATE`;
    if (!rows.length) throw absent();
    await hooks.afterSessionLock?.();
    return tx.session.findUniqueOrThrow({ where: { id: sessionId } });
  }
  async function locked(tx: Tx, kind: Target, id: string, actor: AarActor, permissions: Permission[], writable = true) {
    const c = await context(kind, id, tx);
    const session = await lockSession(tx, c.sessionId);
    await authorize(tx, session.id, actor, permissions);
    await tx.$queryRaw`SELECT "id" FROM "AfterActionReport" WHERE "id"=${c.reportId}::uuid FOR UPDATE`;
    if (c.reportVersionId) await tx.$queryRaw`SELECT "id" FROM "AfterActionReportVersion" WHERE "id"=${c.reportVersionId}::uuid FOR UPDATE`;
    const report = await tx.afterActionReport.findUniqueOrThrow({ where: { id: c.reportId }, include: reportInclude });
    if (writable && (session.status !== "Closed" || report.status !== "Active")) throw new HttpError(409, "Report content requires an active report and Closed Session");
    return report;
  }
  async function transaction<T>(work: (tx: Tx) => Promise<T>) {
    try { return await client.$transaction(work, { timeout: 30000 }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) throw new HttpError(409, "Conflicting report command. Reload and review.");
      throw error;
    }
  }
  function fingerprint(command: string, target: string, input: unknown, actor: AarActor) {
    return sha256(canonicalJson({ command, target, input, actorId: actor.id }));
  }
  async function replay(tx: Tx, operationId: string, commandFingerprint: string) {
    const old = await tx.afterActionOperation.findUnique({ where: { operationId } });
    if (!old) return null;
    if (old.commandFingerprint !== commandFingerprint) throw new HttpError(409, "Operation ID has already been used for another command");
    return { ...(old.result as unknown as Result), replayed: true };
  }
  async function commit(tx: Tx, command: string, operationId: string | undefined, commandFingerprint: string | undefined, result: Result, report: { sessionId: string }, actor: AarActor, metadata: Prisma.InputJsonObject = {}) {
    const requestId = actor.requestId ?? randomUUID();
    if (operationId) await tx.afterActionOperation.create({ data: {
      operationId, command, commandFingerprint: commandFingerprint!, reportId: result.reportId,
      reportVersionId: result.reportVersionId, artifactId: result.artifactId,
      resultVersion: result.version, result: json(result), requestId,
    } });
    await hooks.beforeAudit?.();
    await tx.auditLog.create({ data: {
      action: "aar_" + command, entityType: "afterActionReport", entityId: result.reportId,
      sessionId: report.sessionId, actorId: actor.id, actorEmail: actor.email,
      summary: "After Action Report " + command,
      metadata: { ...result, ...metadata, operationId: operationId ?? null, requestId },
    } });
    return { ...result, replayed: false };
  }
  async function sources(tx: Tx, sessionId: string, ids: string[], actor: AarActor) {
    if (!ids.length) return [];
    await authorize(tx, sessionId, actor, ["aar:create", "exercise:manage"]);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, "Duplicate source observation");
    const rows = await tx.exerciseObservation.findMany({ where: { id: { in: ids }, sessionId, includeInAar: true } });
    if (rows.length !== ids.length) throw new HttpError(400, "Source observations must be eligible and belong to the same Session");
    return ids.map(id => {
      const r = rows.find(row => row.id === id)!;
      return { area: r.area, summary: r.observation, detail: r.recommendation, sourceObservationId: r.id, sourceObservationVersion: r.version, sourceObservationOperationalId: r.operationalId };
    });
  }
  function caps(report: Report, v: { status: string } | undefined, permissions: Permission[]) {
    const has = (p: Permission) => permissions.includes(p);
    const writable = report.status === "Active" && report.session.status === "Closed";
    return {
      edit: writable && v?.status === "Draft" && has("aar:update-draft"),
      submit: writable && v?.status === "Draft" && has("aar:review"),
      returnToDraft: writable && v?.status === "Under review" && has("aar:review"),
      approve: writable && v?.status === "Under review" && has("aar:approve"),
      createRevision: writable && v?.status === "Approved" && has("aar:create") && has("aar:update-draft"),
      archive: writable && v?.status === "Approved" && has("aar:archive"),
      generatePdf: v?.status === "Approved" && has("aar:read") && has("aar:pdf:generate"),
    };
  }
  function reportView(r: Report) {
    return { id: r.id, operationalId: r.operationalId, sessionId: r.sessionId, owner: r.owner,
      status: r.status, version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt,
      archivedAt: r.archivedAt, archivedById: r.archivedById, archiveReason: r.archiveReason,
      session: { id: r.session.id, operationalId: r.session.operationalId, status: r.session.status, mode: r.session.mode, eventType: r.session.eventType } };
  }
  async function bump(tx: Tx, reportId: string, actor: AarActor) {
    await tx.afterActionReport.update({ where: { id: reportId }, data: { version: { increment: 1 }, updatedById: actor.id } });
  }
  async function create(raw: unknown, actor: AarActor) {
    const input = createSchema.parse(raw);
    const fp = fingerprint("create", input.sessionId, input, actor);
    return transaction(async tx => {
      const session = await lockSession(tx, input.sessionId);
      await authorize(tx, session.id, actor, ["aar:create"], false);
      const old = await replay(tx, input.operationId, fp); if (old) return old;
      if (session.status !== "Closed") throw new HttpError(409, "AAR authoring requires a Closed Session");
      if (await tx.afterActionReport.findUnique({ where: { sessionId: session.id } })) throw new HttpError(409, "This Session already has an After Action Report");
      const snapshots = await sources(tx, session.id, input.sourceObservationIds, actor);
      const seq = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('"AfterActionReport_operational_seq"') AS n`;
      const report = await tx.afterActionReport.create({ data: {
        operationalId: "AAR-" + new Date().getUTCFullYear() + "-" + String(seq[0]!.n).padStart(6, "0"),
        sessionId: session.id, ownerId: actor.id, createdById: actor.id, updatedById: actor.id,
      } });
      const v = await tx.afterActionReportVersion.create({ data: {
        reportId: report.id, revision: 1, title: input.title, eventDate: input.eventDate ? new Date(input.eventDate) : session.endAt ?? session.startAt ?? session.createdAt,
        createdById: actor.id, updatedById: actor.id,
        findings: { create: snapshots.map((s, i) => ({ ...s, sortOrder: i + 1 })) },
      } });
      return commit(tx, "create", input.operationId, fp, { reportId: report.id, reportVersionId: v.id, version: v.version, status: v.status }, report, actor);
    });
  }
  async function edit(id: string, raw: unknown, actor: AarActor) {
    const input = editSchema.parse(raw);
    return transaction(async tx => {
      const report = await locked(tx, "version", id, actor, ["aar:update-draft"]);
      const v = await tx.afterActionReportVersion.findUniqueOrThrow({ where: { id }, include: versionInclude });
      expectVersion(v.version, input.expectedVersion);
      if (v.status !== "Draft") throw new HttpError(409, "Only Draft content can be edited");
      const snapshots = await sources(tx, report.sessionId, input.sourceObservationIds, actor);
      if (input.findings.length + snapshots.length > 100) throw new HttpError(400, "At most 100 findings are permitted");
      const seen = new Set<string>();
      const findings = input.findings.map((f, i) => {
        const old = f.id ? v.findings.find(row => row.id === f.id) : undefined;
        if (f.id && (!old || seen.has(f.id))) throw new HttpError(400, "Unknown or duplicate finding ID");
        if (f.id) seen.add(f.id);
        return { id: f.id, area: f.area, summary: f.summary, detail: f.detail ?? null, sortOrder: i + 1,
          sourceObservationId: old?.sourceObservationId ?? null, sourceObservationVersion: old?.sourceObservationVersion ?? null, sourceObservationOperationalId: old?.sourceObservationOperationalId ?? null };
      });
      await tx.afterActionFinding.deleteMany({ where: { reportVersionId: id } });
      await tx.afterActionLesson.deleteMany({ where: { reportVersionId: id } });
      await tx.afterActionCorrectiveAction.deleteMany({ where: { reportVersionId: id } });
      const next = await tx.afterActionReportVersion.update({ where: { id }, data: {
        title: input.title, eventDate: new Date(input.eventDate), executiveSummary: input.executiveSummary,
        version: { increment: 1 }, updatedById: actor.id,
        findings: { create: [...findings, ...snapshots.map((s, i) => ({ ...s, sortOrder: findings.length + i + 1 }))] },
        lessons: { create: input.lessons.map((l, i) => ({ ...l, sortOrder: i + 1 })) },
        correctiveActions: { create: input.correctiveActions.map((a, i) => ({ recommendation: a.recommendation, owner: a.owner ?? null, targetDate: a.targetDate ? new Date(a.targetDate) : null, sortOrder: i + 1 })) },
      } });
      await bump(tx, report.id, actor);
      return commit(tx, "edit", undefined, undefined, { reportId: report.id, reportVersionId: id, version: next.version, status: next.status }, report, actor);
    });
  }
  async function transition(id: string, command: "submit" | "return-to-draft" | "approve", raw: unknown, actor: AarActor) {
    const input = commandSchema.parse(raw);
    const fp = fingerprint(command, id, input, actor);
    return transaction(async tx => {
      const report = await locked(tx, "version", id, actor, [command === "approve" ? "aar:approve" : "aar:review"], false);
      const old = await replay(tx, input.operationId, fp); if (old) return old;
      if (report.status !== "Active" || report.session.status !== "Closed") throw new HttpError(409, "Report is read only");
      const v = await tx.afterActionReportVersion.findUniqueOrThrow({ where: { id }, include: versionInclude });
      expectVersion(v.version, input.expectedVersion);
      if (v.status !== (command === "submit" ? "Draft" : "Under review")) throw new HttpError(409, "Invalid report transition");
      const now = new Date();
      let data: Prisma.AfterActionReportVersionUncheckedUpdateInput = { version: { increment: 1 }, updatedById: actor.id };
      if (command === "submit") data = { ...data, status: "Under review", submittedAt: now, submittedById: actor.id };
      if (command === "return-to-draft") data = { ...data, status: "Draft", submittedAt: null, submittedById: null };
      if (command === "approve") {
        if (!v.executiveSummary.trim() || (!v.findings.length && !v.lessons.length)) throw new HttpError(400, "Approval requires a summary and at least one finding or lesson");
        const contextSnapshot = { operationalId: report.operationalId, sessionOperationalId: report.session.operationalId,
          mode: report.session.mode, eventType: report.session.eventType, owner: report.owner.displayName,
          author: v.createdBy.displayName, approver: actor.displayName };
        const approved = { ...v, contextSnapshot, approvedAt: now, approvedById: actor.id };
        data = { ...data, status: "Approved", approvedAt: now, approvedById: actor.id, contextSnapshot, contentSha256: contentDigest(approved) };
      }
      const next = await tx.afterActionReportVersion.update({ where: { id }, data });
      await bump(tx, report.id, actor);
      return commit(tx, command, input.operationId, fp, { reportId: report.id, reportVersionId: id, version: next.version, status: next.status }, report, actor, { revision: next.revision, contentSha256: next.contentSha256 });
    });
  }
  async function revision(id: string, raw: unknown, actor: AarActor) {
    const input = commandSchema.parse(raw), fp = fingerprint("revision", id, input, actor);
    return transaction(async tx => {
      const report = await locked(tx, "report", id, actor, ["aar:create", "aar:update-draft"], false);
      const old = await replay(tx, input.operationId, fp); if (old) return old;
      if (report.status !== "Active" || report.session.status !== "Closed") throw new HttpError(409, "Report is read only");
      expectVersion(report.version, input.expectedVersion);
      const base = await tx.afterActionReportVersion.findFirstOrThrow({ where: { reportId: id }, orderBy: { revision: "desc" }, include: versionInclude });
      if (base.status !== "Approved") throw new HttpError(409, "Approve the current revision first");
      if (contentDigest(base) !== base.contentSha256) throw new HttpError(500, "AAR source integrity verification failed");
      const next = await tx.afterActionReportVersion.create({ data: {
        reportId: id, revision: base.revision + 1, basedOnVersionId: base.id, title: base.title,
        eventDate: base.eventDate, executiveSummary: base.executiveSummary, createdById: actor.id, updatedById: actor.id,
        findings: { create: base.findings.map(({ id: _id, reportVersionId: _parent, ...f }) => f) },
        lessons: { create: base.lessons.map(({ id: _id, reportVersionId: _parent, ...l }) => l) },
        correctiveActions: { create: base.correctiveActions.map(({ id: _id, reportVersionId: _parent, ...a }) => a) },
      } });
      await bump(tx, id, actor);
      return commit(tx, "revision", input.operationId, fp, { reportId: id, reportVersionId: next.id, version: next.version, status: next.status }, report, actor);
    });
  }
  async function archive(id: string, raw: unknown, actor: AarActor) {
    const input = archiveSchema.parse(raw), fp = fingerprint("archive", id, input, actor);
    return transaction(async tx => {
      const report = await locked(tx, "report", id, actor, ["aar:archive"], false);
      const old = await replay(tx, input.operationId, fp); if (old) return old;
      if (report.status !== "Active" || report.session.status !== "Closed") throw new HttpError(409, "Report is read only");
      expectVersion(report.version, input.expectedVersion);
      if (await tx.afterActionReportVersion.count({ where: { reportId: id, status: { not: "Approved" } } })) throw new HttpError(409, "Approve the current revision before archiving");
      const next = await tx.afterActionReport.update({ where: { id }, data: { status: "Archived", archivedAt: new Date(), archivedById: actor.id, archiveReason: input.reason, version: { increment: 1 }, updatedById: actor.id } });
      return commit(tx, "archive", input.operationId, fp, { reportId: id, version: next.version, status: next.status }, report, actor);
    });
  }
  async function getReport(id: string, actor: AarActor) {
    const c = await context("report", id); const permissions = await authorize(client, c.sessionId, actor, ["aar:read"]);
    const report = await client.afterActionReport.findUniqueOrThrow({ where: { id }, include: reportInclude });
    const latest = await client.afterActionReportVersion.findFirstOrThrow({ where: { reportId: id }, orderBy: { revision: "desc" }, include: versionInclude });
    return { ...reportView(report), latest, capabilities: caps(report, latest, permissions) };
  }
  async function getVersion(id: string, actor: AarActor) {
    const c = await context("version", id); const permissions = await authorize(client, c.sessionId, actor, ["aar:read"]);
    const report = await client.afterActionReport.findUniqueOrThrow({ where: { id: c.reportId }, include: reportInclude });
    const v = await client.afterActionReportVersion.findUniqueOrThrow({ where: { id }, include: versionInclude });
    const latest = await client.afterActionReportVersion.findFirstOrThrow({ where: { reportId: report.id }, orderBy: { revision: "desc" }, select: { id: true } });
    return { ...v, report: reportView(report), capabilities: { ...caps(report, v, permissions), createRevision: latest.id === id && caps(report, v, permissions).createRevision, archive: latest.id === id && caps(report, v, permissions).archive } };
  }
  async function list(raw: unknown, actor: AarActor) {
    const q = listSchema.parse(raw);
    return client.$transaction(async tx => {
      const permissions = await authorize(tx, q.sessionId, actor, ["aar:read"], false);
      const session = await tx.session.findUnique({ where: { id: q.sessionId }, select: { status: true } }); if (!session) throw absent();
      const where: Prisma.AfterActionReportWhereInput = { sessionId: q.sessionId, status: q.status,
        ...(q.search ? { OR: [{ operationalId: { contains: q.search, mode: "insensitive" } }, { versions: { some: { title: { contains: q.search, mode: "insensitive" } } } }] } : {}) };
      const total = await tx.afterActionReport.count({ where });
      const rows = await tx.afterActionReport.findMany({ where, include: reportInclude, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: q.limit, skip: q.offset });
      const exists = await tx.afterActionReport.count({ where: { sessionId: q.sessionId } });
      return { data: rows.map(reportView), total, limit: q.limit, offset: q.offset,
        capabilities: { create: session.status === "Closed" && exists === 0 && permissions.includes("aar:create"), sourceObservations: permissions.includes("aar:create") && permissions.includes("exercise:manage") } };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async function history(id: string, raw: unknown, actor: AarActor) {
    const q = pageSchema.parse(raw), c = await context("report", id);
    await authorize(client, c.sessionId, actor, ["aar:read"]);
    const where = { reportId: id };
    const [total, data] = await client.$transaction([
      client.afterActionReportVersion.count({ where }),
      client.afterActionReportVersion.findMany({ where, select: { id: true, revision: true, status: true, title: true, version: true, contentSha256: true, approvedAt: true, createdAt: true, basedOnVersionId: true }, orderBy: { revision: "desc" }, take: q.limit, skip: q.offset }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { total, data, ...q };
  }
  async function sourceObservations(sessionId: string, raw: unknown, actor: AarActor) {
    uuid.parse(sessionId); const q = pageSchema.parse(raw);
    await authorize(client, sessionId, actor, ["aar:create", "exercise:manage"], false);
    const where = { sessionId, includeInAar: true };
    const [total, data] = await client.$transaction([
      client.exerciseObservation.count({ where }),
      client.exerciseObservation.findMany({ where, select: { id: true, operationalId: true, version: true, area: true, observation: true, recommendation: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: q.limit, skip: q.offset }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { total, data, ...q };
  }
  async function generatePdf(id: string, raw: unknown, actor: AarActor) {
    const input = commandSchema.parse(raw), fp = fingerprint("pdf", id, input, actor);
    return transaction(async tx => {
      const report = await locked(tx, "version", id, actor, ["aar:read", "aar:pdf:generate"], false);
      const old = await replay(tx, input.operationId, fp); if (old) return old;
      const v = await tx.afterActionReportVersion.findUniqueOrThrow({ where: { id }, include: versionInclude });
      expectVersion(v.version, input.expectedVersion);
      if (v.status !== "Approved") throw new HttpError(409, "Only Approved versions can generate PDF artifacts");
      if (contentDigest(v) !== v.contentSha256) throw new HttpError(500, "AAR source integrity verification failed");
      const artifactId = randomUUID(), generatedAt = new Date();
      const content = await (hooks.render ?? renderAarPdf)({ artifactId, generatedAt, version: v, context: v.contextSnapshot as AarPdfView["context"] });
      if (content.length > aarPdfLimit) throw new HttpError(413, "AAR PDF exceeds the 10 MiB limit");
      const digest = sha256(content);
      await hooks.beforeArtifactInsert?.();
      await tx.afterActionPdfArtifact.create({ data: {
        id: artifactId, operationId: input.operationId, commandFingerprint: fp, reportVersionId: id,
        sourceContentSha256: v.contentSha256!, fileName: report.operationalId + "-r" + v.revision + "-" + artifactId + ".pdf",
        contentSizeBytes: content.length, contentSha256: digest, content: new Uint8Array(content),
        storageKey: "aar-pdf/" + artifactId, generatedAt, generatedById: actor.id, requestId: actor.requestId ?? randomUUID(),
      }, select: { id: true } });
      return commit(tx, "pdf", input.operationId, fp, { reportId: report.id, reportVersionId: id, artifactId, version: v.version, status: "Ready" }, report, actor,
        { revision: v.revision, rendererVersion: "aar-pdf-v1", contentSha256: digest, sourceContentSha256: v.contentSha256, contentSizeBytes: content.length });
    });
  }
  async function artifact(id: string, actor: AarActor) {
    const c = await context("artifact", id); await authorize(client, c.sessionId, actor, ["aar:read"]);
    const row = await client.afterActionPdfArtifact.findUniqueOrThrow({ where: { id }, select: artifactSelect });
    return { ...row, contentSizeBytes: Number(row.contentSizeBytes) };
  }
  async function artifacts(id: string, raw: unknown, actor: AarActor) {
    const q = pageSchema.parse(raw), c = await context("version", id); await authorize(client, c.sessionId, actor, ["aar:read"]);
    const where = { reportVersionId: id };
    const [total, rows] = await client.$transaction([
      client.afterActionPdfArtifact.count({ where }),
      client.afterActionPdfArtifact.findMany({ where, select: artifactSelect, orderBy: [{ generatedAt: "desc" }, { id: "asc" }], take: q.limit, skip: q.offset }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { total, data: rows.map(row => ({ ...row, contentSizeBytes: Number(row.contentSizeBytes) })), ...q };
  }
  async function download(id: string, actor: AarActor) {
    const c = await context("artifact", id); await authorize(client, c.sessionId, actor, ["aar:read"]);
    const row = await client.afterActionPdfArtifact.findUniqueOrThrow({ where: { id }, select: { ...artifactSelect, content: true } });
    const content = Buffer.from(row.content);
    if (content.length !== Number(row.contentSizeBytes) || sha256(content) !== row.contentSha256) throw new HttpError(500, "AAR PDF integrity verification failed");
    const { content: _bytes, ...metadata } = row;
    return { metadata: { ...metadata, contentSizeBytes: content.length }, content };
  }
  return { kind: "postgres" as const, context, create, edit, transition, revision, archive, getReport, getVersion, list, history, sourceObservations, generatePdf, artifact, artifacts, download };
}
export type PrismaAfterActionReportService = ReturnType<typeof createPrismaAfterActionReportService>;

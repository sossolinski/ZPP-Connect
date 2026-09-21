const uuid = { type: "string", format: "uuid" };
const command = { type: "object", additionalProperties: false, required: ["operationId", "expectedVersion"], properties: { operationId: uuid, expectedVersion: { type: "integer", minimum: 1 } } };
const page = [
  { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
  { in: "query", name: "offset", schema: { type: "integer", minimum: 0, default: 0 } },
];
const id = { in: "path", name: "id", required: true, schema: uuid };
const responses = {
  "200": { description: "Authorized result. Metadata never includes PDF bytes." },
  "400": { description: "Strict validation or approval prerequisites failed" },
  "401": { description: "Authentication required" }, "403": { description: "Collection permission denied" },
  "404": { description: "Unknown or inaccessible resource (identical response)" },
  "409": { description: "Stale version, lifecycle, duplicate Session report or operation reuse conflict" },
  "413": { description: "Request or generated PDF exceeds its byte limit" },
  "500": { description: "Internal failure or source/artifact integrity verification failed; no PDF bytes served" },
};
const requestBody = (schema: object) => ({ required: true, content: { "application/json": { schema } } });
const get = (summary: string, parameters: object[] = [id]) => ({ summary, parameters, responses: { ...responses } });
const post = (summary: string, schema: object = command, parameters: object[] = [id]) => ({ summary, parameters, requestBody: requestBody(schema), responses: { ...responses, "201": { description: "Created; operation replay returns 200 with the same durable result identifiers" } } });
export const aarOpenApiPaths = {
  "/after-action-reports": {
    get: get("List AARs for a Session (session:read + aar:read), with total and server capabilities", [...page, { in: "query", name: "sessionId", required: true, schema: uuid }, { in: "query", name: "status", schema: { type: "string", enum: ["Active", "Archived"] } }, { in: "query", name: "search", schema: { type: "string", maxLength: 200 } }]),
    post: post("Create one AAR for a Closed Session (aar:create); actor is server-owned", { type: "object", additionalProperties: false, required: ["operationId", "sessionId", "title"], properties: {
      operationId: uuid, sessionId: uuid, title: { type: "string", minLength: 1, maxLength: 500 }, eventDate: { type: "string", format: "date-time" }, sourceObservationIds: { type: "array", maxItems: 100, items: uuid, description: "Same-Session includeInAar snapshots; also requires exercise:manage" },
    } }, []),
  },
  "/after-action-reports/{id}": { get: get("Current report, latest revision and effective server capabilities (aar:read)") },
  "/after-action-reports/{id}/versions": { get: get("Immutable history and mutable current revision metadata (aar:read)", [id, ...page]) },
  "/after-action-report-versions/{id}": {
    get: get("Exact version and ordered sections (aar:read)"),
    patch: { ...post("Replace Draft sections atomically (aar:update-draft); finding IDs preserve source provenance", { $ref: "#/components/schemas/AarDraftEdit" }), responses: { ...responses } },
  },
  "/after-action-report-versions/{id}/submit": { post: post("Draft to Under review (aar:review)") },
  "/after-action-report-versions/{id}/return-to-draft": { post: post("Under review to Draft (aar:review)") },
  "/after-action-report-versions/{id}/approve": { post: post("Approve immutable content and aar-v1 SHA-256 (aar:approve)") },
  "/after-action-reports/{id}/revisions": { post: post("Clone latest Approved revision; expectedVersion is the REPORT token (aar:create + aar:update-draft)") },
  "/after-action-reports/{id}/archive": { post: post("Archive with no mutable revision; expectedVersion is the REPORT token (aar:archive)", { ...command, required: [...command.required, "reason"], properties: { ...command.properties, reason: { type: "string", minLength: 1, maxLength: 2000 } } }) },
  "/sessions/{sessionId}/aar-source-observations": { get: get("Eligible Observation snapshots (session:read + aar:create + exercise:manage)", [{ in: "path", name: "sessionId", required: true, schema: uuid }, ...page]) },
  "/after-action-report-versions/{id}/pdf-artifacts": {
    get: get("Retained artifact metadata only (aar:read)", [id, ...page]),
    post: post("Render exact Approved version, verify source digest, retain up to 10 MiB atomically (aar:read + aar:pdf:generate)"),
  },
  "/after-action-pdf-artifacts/{id}": { get: get("Artifact hashes, size, renderer and generation provenance; no BYTEA (aar:read)") },
  "/after-action-pdf-artifacts/{id}/download": { get: {
    ...get("Rehash retained bytes and download; never regenerate (aar:read)"),
    responses: { ...responses, "200": { description: "Exact retained bytes, verified against size and SHA-256. Not a digital signature.", content: { "application/pdf": { schema: { type: "string", format: "binary" } } }, headers: Object.fromEntries(["Content-Disposition", "Content-Length", "Cache-Control", "X-AAR-Artifact-Id", "X-Content-SHA256", "X-Source-Content-SHA256"].map(name => [name, { schema: { type: "string" } }])) } },
  } },
};
const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
export const aarOpenApiSchemas = {
  AarError: { type: "object", required: ["error"], properties: { error: { type: "string" }, details: { type: "object", description: "Optional strict validation details" } } },
  AarCommandResult: { type: "object", required: ["reportId", "version", "status", "replayed"], properties: { reportId: uuid, reportVersionId: uuid, artifactId: uuid, version: { type: "integer", minimum: 1 }, status: { type: "string", enum: ["Draft", "Under review", "Approved", "Archived", "Ready"] }, replayed: { type: "boolean" } } },
  AarActor: { type: "object", required: ["id", "displayName"], properties: { id: uuid, displayName: { type: "string" } } },
  AarCapabilities: { type: "object", required: ["edit", "submit", "returnToDraft", "approve", "createRevision", "archive", "generatePdf"], properties: Object.fromEntries(["edit", "submit", "returnToDraft", "approve", "createRevision", "archive", "generatePdf"].map(k => [k, { type: "boolean" }])) },
  AarReportRecord: { type: "object", required: ["id", "operationalId", "sessionId", "owner", "status", "version", "session", "createdAt", "updatedAt"], properties: {
    id: uuid, operationalId: { type: "string" }, sessionId: uuid, owner: { $ref: "#/components/schemas/AarActor" },
    status: { type: "string", enum: ["Active", "Archived"] }, version: { type: "integer", minimum: 1 },
    createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" }, archivedAt: { type: "string", format: "date-time", nullable: true }, archivedById: { ...uuid, nullable: true }, archiveReason: { type: "string", nullable: true },
    session: { type: "object", required: ["id", "operationalId", "status", "mode", "eventType"], properties: { id: uuid, operationalId: { type: "string" }, status: { type: "string" }, mode: { type: "string", enum: ["REAL", "EXERCISE", "TRAINING"] }, eventType: { type: "string" } } },
  } },
  AarReport: { allOf: [{ $ref: "#/components/schemas/AarReportRecord" }, { type: "object", required: ["latest", "capabilities"], properties: { latest: { $ref: "#/components/schemas/AarVersionContent" }, capabilities: { $ref: "#/components/schemas/AarCapabilities" } } }] },
  AarVersionContent: { type: "object", required: ["id", "reportId", "revision", "status", "title", "eventDate", "executiveSummary", "schemaVersion", "version", "findings", "lessons", "correctiveActions"], properties: {
    id: uuid, reportId: uuid, revision: { type: "integer", minimum: 1 }, version: { type: "integer", minimum: 1 }, basedOnVersionId: { ...uuid, nullable: true },
    status: { type: "string", enum: ["Draft", "Under review", "Approved"] }, title: text(500), eventDate: { type: "string", format: "date-time" }, executiveSummary: { type: "string", maxLength: 50000 }, schemaVersion: { type: "string", enum: ["aar-v1"] },
    contentSha256: { type: "string", pattern: "^[a-f0-9]{64}$", nullable: true }, contextSnapshot: { type: "object", description: "Immutable approval snapshot: operationalId, sessionOperationalId, mode, eventType, owner, author, approver (display names)" },
    ...Object.fromEntries(["createdById", "updatedById", "submittedById", "approvedById"].map(k => [k, { ...uuid, nullable: k === "submittedById" || k === "approvedById" }])),
    ...Object.fromEntries(["createdAt", "updatedAt", "submittedAt", "approvedAt"].map(k => [k, { type: "string", format: "date-time", nullable: k === "submittedAt" || k === "approvedAt" }])),
    createdBy: { $ref: "#/components/schemas/AarActor" }, submittedBy: { allOf: [{ $ref: "#/components/schemas/AarActor" }], nullable: true }, approvedBy: { allOf: [{ $ref: "#/components/schemas/AarActor" }], nullable: true },
    findings: { type: "array", maxItems: 100, items: { type: "object", properties: { id: uuid, reportVersionId: uuid, sortOrder: { type: "integer" }, area: text(200), summary: text(10000), detail: { type: "string", nullable: true }, sourceObservationId: { ...uuid, nullable: true }, sourceObservationVersion: { type: "integer", nullable: true }, sourceObservationOperationalId: { type: "string", nullable: true } } } },
    lessons: { type: "array", maxItems: 100, items: { type: "object", properties: { id: uuid, reportVersionId: uuid, sortOrder: { type: "integer" }, statement: text(10000) } } },
    correctiveActions: { type: "array", maxItems: 100, items: { type: "object", properties: { id: uuid, reportVersionId: uuid, sortOrder: { type: "integer" }, recommendation: text(10000), owner: { type: "string", nullable: true }, targetDate: { type: "string", format: "date-time", nullable: true } } } },
  } },
  AarVersion: { allOf: [{ $ref: "#/components/schemas/AarVersionContent" }, { type: "object", required: ["report", "capabilities"], properties: { report: { $ref: "#/components/schemas/AarReportRecord" }, capabilities: { $ref: "#/components/schemas/AarCapabilities" } } }] },
  AarArtifact: { type: "object", required: ["id", "operationId", "reportVersionId", "sourceContentSha256", "contentSha256", "contentSizeBytes", "fileName", "mimeType", "rendererVersion", "storageProvider", "storageKey", "status", "generatedAt", "generatedById", "generatedBy", "requestId"], properties: {
    id: uuid, operationId: uuid, reportVersionId: uuid, sourceContentSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, contentSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    contentSizeBytes: { type: "integer", minimum: 1, maximum: 10485760 }, fileName: { type: "string" }, mimeType: { type: "string", enum: ["application/pdf"] }, rendererVersion: { type: "string", enum: ["aar-pdf-v1"] },
    storageProvider: { type: "string", enum: ["postgres"] }, storageKey: { type: "string" }, status: { type: "string", enum: ["Ready"] }, generatedAt: { type: "string", format: "date-time" }, generatedById: uuid, generatedBy: { $ref: "#/components/schemas/AarActor" }, requestId: { type: "string" },
  } },
  AarDraftEdit: { type: "object", additionalProperties: false, required: ["expectedVersion", "title", "eventDate", "executiveSummary", "findings", "lessons", "correctiveActions"], properties: {
    expectedVersion: { type: "integer", minimum: 1 }, title: text(500), eventDate: { type: "string", format: "date-time" }, executiveSummary: { type: "string", maxLength: 50000 },
    findings: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, required: ["area", "summary"], properties: { id: uuid, area: text(200), summary: text(10000), detail: { type: "string", maxLength: 10000, nullable: true } } } },
    lessons: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, required: ["statement"], properties: { statement: text(10000) } } },
    correctiveActions: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, required: ["recommendation"], properties: { recommendation: text(10000), owner: { type: "string", maxLength: 200, nullable: true }, targetDate: { type: "string", format: "date-time", nullable: true } } } },
    sourceObservationIds: { type: "array", maxItems: 100, items: uuid },
  } },
};
const pageOf = (items: object, extra: object = {}) => ({ type: "object", required: ["data", "total", "limit", "offset"], properties: { data: { type: "array", items }, total: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 200 }, offset: { type: "integer", minimum: 0 }, ...extra } });
const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
const readSchemas: Record<string, object> = {
  "/after-action-reports": pageOf(ref("AarReportRecord"), { capabilities: { type: "object", required: ["create", "sourceObservations"], properties: { create: { type: "boolean" }, sourceObservations: { type: "boolean" } } } }),
  "/after-action-reports/{id}": ref("AarReport"),
  "/after-action-reports/{id}/versions": pageOf({ type: "object", properties: { id: uuid, revision: { type: "integer" }, status: { type: "string" }, title: { type: "string" }, version: { type: "integer" }, contentSha256: { type: "string", nullable: true }, approvedAt: { type: "string", format: "date-time", nullable: true }, createdAt: { type: "string", format: "date-time" }, basedOnVersionId: { ...uuid, nullable: true } } }),
  "/after-action-report-versions/{id}": ref("AarVersion"),
  "/sessions/{sessionId}/aar-source-observations": pageOf({ type: "object", properties: { id: uuid, operationalId: { type: "string" }, version: { type: "integer" }, area: { type: "string" }, observation: { type: "string" }, recommendation: { type: "string", nullable: true } } }),
  "/after-action-report-versions/{id}/pdf-artifacts": pageOf(ref("AarArtifact")),
  "/after-action-pdf-artifacts/{id}": ref("AarArtifact"),
};
for (const [path, entry] of Object.entries(aarOpenApiPaths)) {
  for (const [method, op] of Object.entries(entry)) {
    const operation = op as { responses: Record<string, { description: string; content?: object }> };
    for (const code of ["400", "401", "403", "404", "409", "413", "500"]) operation.responses[code] = { ...responses[code as keyof typeof responses], content: { "application/json": { schema: ref("AarError") } } };
    if (path.endsWith("/download")) continue;
    const schema = method === "get" ? readSchemas[path]! : ref("AarCommandResult");
    operation.responses["200"] = { description: "Authorized result", content: { "application/json": { schema } } };
    const creates = method === "post" && ["/after-action-reports", "/after-action-reports/{id}/revisions", "/after-action-report-versions/{id}/pdf-artifacts"].includes(path);
    if (creates) operation.responses["201"] = { description: "Created; identical operation replay returns 200", content: { "application/json": { schema } } };
    else delete operation.responses["201"];
  }
}

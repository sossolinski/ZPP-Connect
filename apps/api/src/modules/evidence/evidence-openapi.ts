const uuid = { type: "string", format: "uuid" };
const sessionId = { in: "path", name: "sessionId", required: true, schema: uuid };
const evidenceId = { in: "path", name: "evidenceId", required: true, schema: uuid };
const errors = {
  "400": { description: "Invalid metadata, unsafe file name, unsupported or mismatched content, or configured size exceeded" },
  "401": { description: "Authentication required" },
  "403": { description: "Effective incident evidence permission denied" },
  "404": { description: "Unknown or inaccessible incident evidence" },
  "409": { description: "Non-REAL/read-only incident, stale version, withdrawn file, or operation reuse conflict" },
  "500": { description: "Retained byte size or SHA-256 integrity verification failed; no bytes served" },
};

export const evidenceOpenApiSchemas = {
  EvidenceActor: { type: "object", required: ["id", "displayName", "email"], properties: { id: uuid, displayName: { type: "string" }, email: { type: "string" } } },
  EvidenceRecord: { type: "object", required: ["id", "operationalId", "sessionId", "originalFileName", "fileName", "mimeType", "declaredMimeType", "sizeBytes", "contentSha256", "category", "status", "scanStatus", "version", "createdAt", "createdBy"], properties: {
    id: uuid, operationalId: { type: "string" }, sessionId: uuid, originalFileName: { type: "string", maxLength: 255 }, fileName: { type: "string", maxLength: 255 },
    mimeType: { type: "string", enum: ["application/pdf", "image/jpeg", "image/png", "text/plain"] }, declaredMimeType: { type: "string" }, sizeBytes: { type: "integer", minimum: 1, maximum: 20971520 },
    contentSha256: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Integrity digest; not a digital signature or authenticity claim." },
    category: { type: "string", enum: ["Photograph", "Scanned document", "Authority correspondence", "Operational evidence", "External report", "Reference"] }, description: { type: "string", nullable: true, maxLength: 4000 },
    status: { type: "string", enum: ["Active", "Withdrawn"] }, scanStatus: { type: "string", enum: ["NOT_CONFIGURED"] }, version: { type: "integer", minimum: 1 },
    createdAt: { type: "string", format: "date-time" }, createdBy: { $ref: "#/components/schemas/EvidenceActor" }, withdrawnAt: { type: "string", format: "date-time", nullable: true }, withdrawalReason: { type: "string", nullable: true }, withdrawnBy: { allOf: [{ $ref: "#/components/schemas/EvidenceActor" }], nullable: true }, replayed: { type: "boolean" },
  } },
};

const jsonRecord = { content: { "application/json": { schema: { $ref: "#/components/schemas/EvidenceRecord" } } } };
export const evidenceOpenApiPaths = {
  "/sessions/{sessionId}/evidence": {
    get: { summary: "List server-paged retained evidence for one REAL incident (evidence:read)", parameters: [sessionId, { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 200 } }, { in: "query", name: "offset", schema: { type: "integer", minimum: 0 } }, { in: "query", name: "includeWithdrawn", schema: { type: "boolean" } }], responses: { "200": { description: "Evidence page; never includes bytes" }, ...errors } },
    post: { summary: "Retain one validated file for a writable REAL incident (evidence:upload)", parameters: [sessionId], requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["operationId", "category", "file"], properties: { operationId: uuid, category: { type: "string" }, description: { type: "string", maxLength: 4000 }, file: { type: "string", format: "binary" } } } } } }, responses: { "200": { description: "Idempotent replay", ...jsonRecord }, "201": { description: "Evidence retained", ...jsonRecord }, ...errors } },
  },
  "/sessions/{sessionId}/evidence/{evidenceId}": { get: { summary: "Get retained evidence metadata without bytes (evidence:read)", parameters: [sessionId, evidenceId], responses: { "200": { description: "Evidence metadata", ...jsonRecord }, ...errors } } },
  "/sessions/{sessionId}/evidence/{evidenceId}/download": { get: { summary: "Verify size and SHA-256, audit, then serve exact retained bytes (evidence:read)", parameters: [sessionId, evidenceId], responses: { "200": { description: "Exact integrity-verified retained bytes", headers: { "Content-Disposition": { schema: { type: "string" } }, "Content-Length": { schema: { type: "integer" } }, "X-Content-SHA256": { schema: { type: "string" } } }, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }, ...errors } } },
  "/sessions/{sessionId}/evidence/{evidenceId}/withdraw": { post: { summary: "Withdraw access while retaining immutable metadata and bytes (evidence:withdraw)", parameters: [sessionId, evidenceId], requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["operationId", "expectedVersion", "reason"], properties: { operationId: uuid, expectedVersion: { type: "integer", minimum: 1 }, reason: { type: "string", minLength: 1, maxLength: 2000 } } } } } }, responses: { "200": { description: "Withdrawn record or idempotent replay", ...jsonRecord }, ...errors } } },
};


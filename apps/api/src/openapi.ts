export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "ZPP Connect API",
    version: "0.1.0",
    description:
      "Internal Family Assistance, Next-of-Kin Matching and Reunification Platform API for LOT/ZPP operations.",
  },
  servers: [{ url: "/api" }],
  security: [{ DevUserHeader: [] }, { BearerAuth: [] }],
  components: {
    securitySchemes: {
      DevUserHeader: {
        type: "apiKey",
        in: "header",
        name: "x-user-email",
        description:
          "Development-only user selector. Use Microsoft Entra ID/JWT in secured deployments.",
      },
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
    schemas: {
      DictionaryPolicy: {
        type: "object",
        required: ["category", "classification", "authority", "protected", "keyImmutable"],
        properties: {
          category: { type: "string" },
          classification: { type: "string", enum: ["E", "P", "X"] },
          authority: { type: "string", enum: ["postgres", "code"] },
          protected: { type: "boolean" },
          allowCreate: { type: "boolean" },
          allowLabelEdit: { type: "boolean" },
          allowDescriptionEdit: { type: "boolean" },
          allowReorder: { type: "boolean" },
          allowDeactivate: { type: "boolean" },
          allowReactivate: { type: "boolean" },
          keyImmutable: { type: "boolean" },
          reason: { type: "string" },
        },
      },
      DictionaryAdminRecord: {
        type: "object",
        required: ["id", "profile", "category", "key", "normalizedKey", "label", "sortOrder", "isActive", "version", "sourceType", "policy"],
        properties: {
          id: { type: "string", format: "uuid" },
          profile: { type: "string" },
          category: { type: "string" },
          key: { type: "string", description: "Immutable stable identity after creation." },
          normalizedKey: { type: "string", readOnly: true },
          label: { type: "string" },
          description: { type: "string", nullable: true },
          sortOrder: { type: "integer" },
          isActive: { type: "boolean" },
          version: { type: "integer", minimum: 1 },
          sourceType: { type: "string" },
          policy: { $ref: "#/components/schemas/DictionaryPolicy" },
        },
      },
      DictionaryVersionCommand: {
        type: "object",
        required: ["expectedVersion"],
        properties: { expectedVersion: { type: "integer", minimum: 1 } },
        additionalProperties: false,
      },
    },
  },
  paths: {
    "/auth/me": {
      get: {
        summary: "Return authenticated user, roles and permissions",
        responses: { "200": { description: "OK" } },
      },
    },
    "/dashboard": {
      get: {
        summary: "Operational dashboard aggregates",
        responses: { "200": { description: "OK" } },
      },
    },
    "/sessions": {
      get: {
        summary: "List sessions",
        responses: { "200": { description: "OK" } },
      },
      post: {
        summary: "Create session",
        responses: { "201": { description: "Created" } },
      },
    },
    "/sessions/{id}": {
      get: {
        summary:
          "Get an assigned session without disclosing inaccessible incidents",
      },
      patch: { summary: "Update an assigned session" },
    },
    "/sessions/{id}/assignments": {
      get: { summary: "List incident assignments" },
      post: { summary: "Assign a user to an incident" },
    },
    "/sessions/{id}/assignments/{assignmentId}/revoke": {
      post: { summary: "Revoke incident access without deleting history" },
    },
    "/sessions/{id}/assignments/{assignmentId}/reactivate": {
      post: { summary: "Reactivate an existing incident assignment" },
    },
    "/enquiries": {
      get: { summary: "List enquiries" },
      post: { summary: "Create enquiry" },
    },
    "/family-records": {
      get: { summary: "List incident-scoped family/NOK relationship claims" },
      post: { summary: "Register family/NOK contact and relationship claim" },
    },
    "/family-records/{id}/verify": {
      post: { summary: "Record a human relationship verification decision" },
    },
    "/family-records/{id}/reject": {
      post: { summary: "Reject a relationship claim with a human decision" },
    },
    "/family-records/{id}/reopen": {
      post: { summary: "Reopen a terminal relationship decision for review" },
    },
    "/passenger-records": {
      get: { summary: "List passenger/crew records" },
      post: { summary: "Create passenger/crew record" },
    },
    "/matching-records": {
      get: {
        summary:
          "List read-only Release compatibility projections for human-confirmed matches",
      },
    },
    "/matching/queue": {
      get: {
        summary:
          "List server-paged current relationship claims by matching state",
      },
    },
    "/matching/claims/{claimId}": {
      get: {
        summary:
          "Get matching context, persisted suggestions and human decision history",
      },
    },
    "/matching/claims/{claimId}/suggestions": {
      get: { summary: "List immutable persisted match suggestions" },
    },
    "/matching/claims/{claimId}/suggestions/generate": {
      post: {
        summary:
          "Generate a narrowed explainable suggestion set without confirming a match",
      },
    },
    "/matching/claims/{claimId}/candidates": {
      get: {
        summary:
          "Search incident-scoped Passenger candidates for manual review",
      },
    },
    "/matching/claims/{claimId}/confirm": {
      post: { summary: "Append an idempotent human match confirmation" },
    },
    "/matching/claims/{claimId}/reject": {
      post: { summary: "Append an idempotent human suggestion rejection" },
    },
    "/matching/claims/{claimId}/invalidate": {
      post: { summary: "Invalidate a current human match decision" },
    },
    "/releases": {
      get: {
        summary:
          "List read-only legacy compatibility projections for Release consumers",
      },
    },
    "/releases/queue": {
      get: {
        summary:
          "List the server-paged ReleaseAction queue with dynamic safety state",
      },
    },
    "/releases/candidates": {
      get: {
        summary:
          "List current human matches available for a controlled ReleaseAction",
      },
    },
    "/releases/{id}": {
      get: {
        summary:
          "Get Passenger, NOK, match, independent checks and current release preconditions",
      },
    },
    "/releases/prepare": {
      post: {
        summary:
          "Prepare an idempotent ReleaseAction without authorizing or completing it",
      },
    },
    "/releases/{id}/checks/identity": {
      post: { summary: "Record an explicit human identity ReleaseCheck" },
    },
    "/releases/{id}/checks/hold": {
      post: {
        summary: "Review current Passenger hold state without mutating it",
      },
    },
    "/releases/{id}/authorize": {
      post: {
        summary: "Freshly revalidate and authorize an eligible ReleaseAction",
      },
    },
    "/releases/{id}/complete": {
      post: {
        summary:
          "Record explicit operational completion after fresh revalidation",
      },
    },
    "/releases/{id}/cancel": {
      post: { summary: "Cancel a prepared or authorized ReleaseAction" },
    },
    "/requests": {
      get: { summary: "List read-only Request compatibility projections" },
      post: { summary: "Create an idempotent incident-scoped Request" },
    },
    "/requests/queue": {
      get: {
        summary:
          "List the server-paged Request queue with search, ownership and due filters",
      },
    },
    "/requests/assignees": {
      get: { summary: "List active incident-assigned Request owners" },
    },
    "/requests/{id}": {
      get: {
        summary: "Get a Request with permission-intersected linked context",
      },
      patch: {
        summary: "Correct editable Request facts with optimistic locking",
      },
    },
    "/requests/{id}/assign": {
      post: { summary: "Assign or reassign a Request owner" },
    },
    "/requests/{id}/unassign": {
      post: { summary: "Remove a Request owner with a recorded reason" },
    },
    "/requests/{id}/priority": {
      post: {
        summary:
          "Change Request priority without bypassing access or linked workflows",
      },
    },
    "/requests/{id}/start": {
      post: { summary: "Move a Request into controlled work" },
    },
    "/requests/{id}/wait": {
      post: { summary: "Move a Request into controlled waiting state" },
    },
    "/requests/{id}/resolve": {
      post: { summary: "Record an idempotent human Request resolution" },
    },
    "/requests/{id}/reopen": {
      post: { summary: "Reopen a resolved Request while preserving history" },
    },
    "/requests/{id}/cancel": {
      post: { summary: "Cancel a Request without marking it resolved" },
    },
    "/assignments": {
      get: { summary: "Deprecated read-only operational assignment projection" },
      post: { summary: "Create an idempotent open operational assignment" },
    },
    "/assignments/queue": {
      get: { summary: "List the filtered, paged operational assignment queue" },
    },
    "/assignments/assignees": {
      get: { summary: "Search active incident-scoped eligible assignment candidates" },
    },
    "/assignments/{id}": {
      get: { summary: "Get incident-scoped operational assignment context" },
      patch: { summary: "Update versioned assignment facts and planning fields only" },
    },
    "/assignments/{id}/assign": {
      post: { summary: "Assign operational task owner" },
    },
    "/assignments/{id}/claim": {
      post: { summary: "Atomically claim an unassigned operational task" },
    },
    "/assignments/{id}/reassign": {
      post: { summary: "Reassign operational task owner" },
    },
    "/assignments/{id}/start": {
      post: { summary: "Start an open operational assignment" },
    },
    "/assignments/{id}/escalate": {
      post: { summary: "Escalate an in-progress operational assignment" },
    },
    "/assignments/{id}/resume": {
      post: { summary: "Resume an escalated operational assignment" },
    },
    "/assignments/{id}/complete": {
      post: { summary: "Idempotently complete an in-progress operational assignment" },
    },
    "/assignments/{id}/cancel": {
      post: { summary: "Idempotently cancel an active operational assignment" },
    },
    "/timeline": {
      get: { summary: "Case timeline" },
      post: { summary: "Add timeline note/event" },
    },
    "/imports/{type}": {
      post: { summary: "Idempotently validate a bounded CSV into a durable Incident-scoped import snapshot" },
    },
    "/imports/{id}": {
      get: { summary: "Read an authorized durable Import batch" },
    },
    "/imports/{id}/rows": {
      get: { summary: "Page authorized durable validation rows in stable row order" },
    },
    "/imports/{id}/confirm": {
      post: { summary: "Idempotently confirm a durable Import batch in one target-domain transaction" },
    },
    "/sessions/{sessionId}/imports": {
      get: { summary: "List authorized durable Import batches for an Incident" },
    },
    "/files": {
      get: { summary: "List truthful source-provenance projections for authorized Import batches" },
    },
    "/exports/{type}": {
      post: { summary: "Prepare an authorized CSV export and commit durable provenance before returning bytes" },
    },
    "/exports/generations/{id}": {
      get: { summary: "Read authorized durable export preparation metadata" },
    },
    "/sessions/{sessionId}/export-generations": {
      get: { summary: "Page authorized durable export preparation metadata for an Incident" },
    },
    "/reports/session-summary": {
      get: { summary: "Read a permission-filtered PostgreSQL session-summary projection" },
    },
    "/exercise/injects": {
      get: { summary: "Page authorized durable Exercise Inject evidence" },
      post: { summary: "Idempotently create a Planned Inject in an Exercise Incident" },
    },
    "/exercise/injects/{id}": {
      patch: { summary: "Optimistically update a Planned Inject" },
    },
    "/exercise/injects/{id}/release": {
      post: { summary: "Idempotently release and seal an Inject" },
    },
    "/exercise/injects/{id}/complete": {
      post: { summary: "Idempotently complete a Released Inject" },
    },
    "/exercise/observations": {
      get: { summary: "Page authorized durable Evaluator Observations" },
      post: { summary: "Idempotently create an Observation and immutable revision" },
    },
    "/exercise/observations/{id}": {
      patch: { summary: "Optimistically update an Observation and append its revision" },
    },
    "/exercise/observations/{id}/history": {
      get: { summary: "Page immutable authorized Observation revision evidence" },
    },
    "/audit-logs": { get: { summary: "Read append-only audit log" } },
    "/admin/users": { get: { summary: "List users" } },
    "/dictionaries": {
      get: {
        summary: "Read the complete new-use dictionary projection from each category's declared authority",
        responses: { "200": { description: "Active PostgreSQL values for extensible categories and canonical code values for protected categories" }, "401": { description: "Unauthenticated" }, "500": { description: "Durable configuration read failed; no editable fallback is returned" } },
      },
    },
    "/admin/dictionary-policies": {
      get: {
        summary: "List dictionary governance and supported actions",
        responses: { "200": { description: "Policy list" }, "401": { description: "Unauthenticated" }, "403": { description: "Missing admin:manage" } },
      },
    },
    "/admin/dictionaries": {
      get: {
        summary: "Page and filter durable dictionary rows with governance metadata",
        parameters: [
          { name: "category", in: "query", schema: { type: "string" } },
          { name: "active", in: "query", schema: { type: "boolean" } },
          { name: "search", in: "query", schema: { type: "string", maxLength: 200 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
        ],
        responses: { "200": { description: "Paged dictionary rows" }, "400": { description: "Invalid filters" }, "401": { description: "Unauthenticated" }, "403": { description: "Missing admin:manage" }, "500": { description: "Durable read failed" } },
      },
      post: {
        summary: "Create a value only in a policy-supported extensible category",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["category", "key", "label"], properties: { category: { type: "string" }, key: { type: "string", maxLength: 80 }, label: { type: "string", maxLength: 200 }, description: { type: "string", nullable: true, maxLength: 1000 }, sortOrder: { type: "integer", minimum: -1000000, maximum: 1000000 } }, additionalProperties: false } } } },
        responses: { "201": { description: "Created" }, "400": { description: "Invalid command" }, "401": { description: "Unauthenticated" }, "403": { description: "Missing admin:manage" }, "409": { description: "Protected category, duplicate semantic key, or concurrent conflict" } },
      },
    },
    "/admin/dictionaries/{id}": {
      patch: {
        summary: "Update mutable presentation fields with expectedVersion optimistic concurrency",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["expectedVersion"], properties: { expectedVersion: { type: "integer", minimum: 1 }, label: { type: "string", maxLength: 200 }, description: { type: "string", nullable: true, maxLength: 1000 }, sortOrder: { type: "integer", minimum: -1000000, maximum: 1000000 } }, additionalProperties: false } } } },
        responses: { "200": { description: "Updated" }, "400": { description: "Invalid command or immutable identity field" }, "401": { description: "Unauthenticated" }, "403": { description: "Missing admin:manage" }, "404": { description: "Dictionary value not found" }, "409": { description: "Protected category or stale expectedVersion" } },
      },
    },
    "/admin/dictionaries/{id}/deactivate": {
      post: {
        summary: "Deactivate a policy-supported value for new use without rewriting history",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/DictionaryVersionCommand" } } } },
        responses: { "200": { description: "Deactivated" }, "400": { description: "Invalid expectedVersion" }, "401": { description: "Unauthenticated" }, "403": { description: "Missing admin:manage" }, "404": { description: "Dictionary value not found" }, "409": { description: "Protected category or stale expectedVersion" } },
      },
    },
    "/admin/dictionaries/{id}/reactivate": {
      post: {
        summary: "Reactivate a policy-supported value for new use",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/DictionaryVersionCommand" } } } },
        responses: { "200": { description: "Reactivated" }, "400": { description: "Invalid expectedVersion" }, "401": { description: "Unauthenticated" }, "403": { description: "Missing admin:manage" }, "404": { description: "Dictionary value not found" }, "409": { description: "Protected category or stale expectedVersion" } },
      },
    },
  },
};

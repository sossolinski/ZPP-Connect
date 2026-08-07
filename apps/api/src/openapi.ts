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
      get: { summary: "List operational assignments" },
      post: { summary: "Create operational assignment" },
    },
    "/assignment-assignees": {
      get: {
        summary: "List eligible assignment assignees for manager actions",
      },
    },
    "/assignments/{id}": {
      patch: { summary: "Update operational assignment" },
    },
    "/assignments/{id}/assign": {
      post: { summary: "Assign operational task owner" },
    },
    "/assignments/{id}/assign-to-me": {
      post: { summary: "Assign operational task to current user" },
    },
    "/assignments/{id}/reassign": {
      post: { summary: "Reassign operational task owner" },
    },
    "/assignments/{id}/status": {
      post: { summary: "Update operational task status" },
    },
    "/timeline": {
      get: { summary: "Case timeline" },
      post: { summary: "Add timeline note/event" },
    },
    "/imports/{type}": {
      post: { summary: "Validate CSV records and create import batch" },
    },
    "/exports/{type}": {
      get: { summary: "Export logs or session package as CSV/PDF" },
    },
    "/exercise/injects": {
      get: { summary: "List exercise injects" },
      post: { summary: "Create exercise inject" },
    },
    "/exercise/observations": {
      get: { summary: "List exercise observations" },
      post: { summary: "Create evaluator observation" },
    },
    "/audit-logs": { get: { summary: "Read append-only audit log" } },
    "/admin/users": { get: { summary: "List users" } },
    "/admin/dictionaries": {
      get: { summary: "List dictionaries" },
      post: { summary: "Create dictionary item" },
    },
  },
};

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "ZPP Connect API",
    version: "0.1.0",
    description:
      "Internal Family Assistance, Next-of-Kin Matching and Reunification Platform API for LOT/ZPP operations."
  },
  servers: [{ url: "/api" }],
  security: [{ DevUserHeader: [] }, { BearerAuth: [] }],
  components: {
    securitySchemes: {
      DevUserHeader: {
        type: "apiKey",
        in: "header",
        name: "x-user-email",
        description: "Development-only user selector. Use Microsoft Entra ID/JWT in secured deployments."
      },
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT"
      }
    }
  },
  paths: {
    "/auth/me": { get: { summary: "Return authenticated user, roles and permissions", responses: { "200": { description: "OK" } } } },
    "/dashboard": { get: { summary: "Operational dashboard aggregates", responses: { "200": { description: "OK" } } } },
    "/sessions": { get: { summary: "List sessions", responses: { "200": { description: "OK" } } }, post: { summary: "Create session", responses: { "201": { description: "Created" } } } },
    "/sessions/{id}": { get: { summary: "Get an assigned session without disclosing inaccessible incidents" }, patch: { summary: "Update an assigned session" } },
    "/sessions/{id}/assignments": { get: { summary: "List incident assignments" }, post: { summary: "Assign a user to an incident" } },
    "/sessions/{id}/assignments/{assignmentId}/revoke": { post: { summary: "Revoke incident access without deleting history" } },
    "/sessions/{id}/assignments/{assignmentId}/reactivate": { post: { summary: "Reactivate an existing incident assignment" } },
    "/enquiries": { get: { summary: "List enquiries" }, post: { summary: "Create enquiry" } },
    "/family-records": { get: { summary: "List incident-scoped family/NOK relationship claims" }, post: { summary: "Register family/NOK contact and relationship claim" } },
    "/family-records/{id}/verify": { post: { summary: "Record a human relationship verification decision" } },
    "/family-records/{id}/reject": { post: { summary: "Reject a relationship claim with a human decision" } },
    "/family-records/{id}/reopen": { post: { summary: "Reopen a terminal relationship decision for review" } },
    "/passenger-records": { get: { summary: "List passenger/crew records" }, post: { summary: "Create passenger/crew record" } },
    "/matching-records": { get: { summary: "List matching records" }, post: { summary: "Create controlled potential match" } },
    "/releases": { get: { summary: "List reunification/release records" }, post: { summary: "Prepare reunification or release" } },
    "/requests": { get: { summary: "List welfare/logistics requests" }, post: { summary: "Create welfare/logistics request" } },
    "/assignments": { get: { summary: "List operational assignments" }, post: { summary: "Create operational assignment" } },
    "/assignment-assignees": { get: { summary: "List eligible assignment assignees for manager actions" } },
    "/assignments/{id}": { patch: { summary: "Update operational assignment" } },
    "/assignments/{id}/assign": { post: { summary: "Assign operational task owner" } },
    "/assignments/{id}/assign-to-me": { post: { summary: "Assign operational task to current user" } },
    "/assignments/{id}/reassign": { post: { summary: "Reassign operational task owner" } },
    "/assignments/{id}/status": { post: { summary: "Update operational task status" } },
    "/timeline": { get: { summary: "Case timeline" }, post: { summary: "Add timeline note/event" } },
    "/imports/{type}": { post: { summary: "Validate CSV records and create import batch" } },
    "/exports/{type}": { get: { summary: "Export logs or session package as CSV/PDF" } },
    "/exercise/injects": { get: { summary: "List exercise injects" }, post: { summary: "Create exercise inject" } },
    "/exercise/observations": { get: { summary: "List exercise observations" }, post: { summary: "Create evaluator observation" } },
    "/audit-logs": { get: { summary: "Read append-only audit log" } },
    "/admin/users": { get: { summary: "List users" } },
    "/admin/dictionaries": { get: { summary: "List dictionaries" }, post: { summary: "Create dictionary item" } }
  }
};

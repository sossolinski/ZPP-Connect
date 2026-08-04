# Foundation Stage 2.5 access boundary

The incident security boundary is:

```text
Authentication
→ global domain permission
→ active IncidentAssignment (or named System Admin global override)
→ IncidentContext
→ incident-scoped repository
```

`IncidentAccessService.hasSystemAdminGlobalOverride` is the only policy that
grants cross-incident visibility without an assignment. Routers do not contain
independent admin shortcuts. Mutating an assignment still requires
`incident:members:manage` and is always audited, including when the actor used
the System Admin override.

An authorization decision depends only on an active assignment for the exact
Incident UUID. `function` and `scope` are descriptive operational metadata in
this stage; they do not implement ABAC and do not grant access to another
incident or to every incident of the same REAL, EXERCISE or TRAINING mode.

## Lifecycle API

- `GET /api/sessions/:id/assignments` lists active assignments. System Admin and
  assigned users with `incident:members:read` may call it.
- `GET /api/sessions/:id/assignments?includeInactive=true` also returns revoked
  assignments for access administration.
- `POST /api/sessions/:id/assignments` creates one durable assignment per
  incident/user pair.
- `POST /api/sessions/:id/assignments/:assignmentId/revoke` marks it inactive
  and records revoker, time and reason.
- `POST /api/sessions/:id/assignments/:assignmentId/reactivate` restores that
  same row rather than creating a duplicate.

The audit log retains the full `ASSIGNED`, `REVOKED` and `REACTIVATED` sequence,
including actor, target user ID, incident ID, previous/new state, optional
reason, timestamp and request ID. Together with the durable assignment this
allows access periods to be reconstructed without storing extra personal data.

`GET /api/sessions` is filtered by active assignments before pagination.
`GET /api/sessions/:id` returns 404 without access to avoid disclosing whether
another incident exists. Revocation is read from PostgreSQL on every request;
there is no authorization cache.

Incident creation is one PostgreSQL transaction containing the Session, the
creator's active IncidentAssignment, the assignment audit event and the Session
audit event. A failure rolls back all four writes.

import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPrismaIncidentAccessRepository } from "./modules/incident-access/prisma-incident-access-repository.js";
import { createPrismaRequestRepository } from "./modules/requests/prisma-request-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const prisma = databaseUrl
  ? new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  : null;
const as = (email: string) => ({ "x-user-email": email });
function application() {
  return createApp({
    requestRepository: createPrismaRequestRepository(prisma!),
    incidentAccessRepository: createPrismaIncidentAccessRepository(prisma!),
  });
}

postgresDescribe("Foundation Stage 7 PostgreSQL Request safety", () => {
  const marker = `F7-${Date.now()}`;
  const incidentIds: string[] = [];
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const actors: Record<
    string,
    { id: string; email: string; assignmentId: string }
  > = {};
  let incidentA: string;
  let incidentB: string;
  let closedIncident: string;
  let adminId: string;
  let coordinatorId: string;

  async function actor(key: string, permissions: string[], assigned = true) {
    const role = await prisma!.role.create({
      data: {
        name: `${marker.toLowerCase()}-${key}`,
        displayName: `${marker} ${key}`,
        permissions,
      },
    });
    const user = await prisma!.user.create({
      data: {
        email: `${marker.toLowerCase()}-${key}@example.test`,
        displayName: `${marker} ${key}`,
        roles: { create: { roleId: role.id, assignedBy: "stage7-test" } },
      },
    });
    const assignment = assigned
      ? await prisma!.incidentAssignment.create({
          data: {
            incidentId: incidentA,
            userId: user.id,
            function: `${key} Request test`,
            createdById: adminId,
          },
        })
      : null;
    roleIds.push(role.id);
    userIds.push(user.id);
    actors[key] = {
      id: user.id,
      email: user.email,
      assignmentId: assignment?.id ?? "",
    };
  }
  async function createRequest(
    email = "coordinator@lot.pl",
    values: Record<string, unknown> = {},
    operationId = randomUUID(),
  ) {
    return request(application())
      .post("/api/requests")
      .set(as(email))
      .send({
        sessionId: incidentA,
        category: "Transport",
        priority: "Normal",
        details: `Request ${marker} ${randomUUID()}`,
        operationId,
        ...values,
      });
  }

  beforeAll(async () => {
    await prisma!.$connect();
    const [admin, coordinator] = await Promise.all([
      prisma!.user.findUniqueOrThrow({ where: { email: "admin@lot.pl" } }),
      prisma!.user.findUniqueOrThrow({
        where: { email: "coordinator@lot.pl" },
      }),
    ]);
    adminId = admin.id;
    coordinatorId = coordinator.id;
    const [exercise, training, closed] = await Promise.all([
      prisma!.session.create({
        data: {
          operationalId: `${marker}-EX`,
          mode: "EXERCISE",
          status: "Active",
          eventType: marker,
          createdById: adminId,
        },
      }),
      prisma!.session.create({
        data: {
          operationalId: `${marker}-REAL`,
          mode: "REAL",
          status: "Draft",
          eventType: marker,
          createdById: adminId,
        },
      }),
      prisma!.session.create({
        data: {
          operationalId: `${marker}-CLOSED`,
          mode: "TRAINING",
          status: "Closed",
          eventType: marker,
          createdById: adminId,
        },
      }),
    ]);
    incidentA = exercise.id;
    incidentB = training.id;
    closedIncident = closed.id;
    incidentIds.push(incidentA, incidentB, closedIncident);
    await prisma!.incidentAssignment.createMany({
      data: [
        {
          incidentId: incidentA,
          userId: coordinatorId,
          function: "Request coordinator",
          createdById: adminId,
        },
        {
          incidentId: closedIncident,
          userId: coordinatorId,
          function: "Closed Request coordinator",
          createdById: adminId,
        },
      ],
    });
    await actor("reader", ["session:read", "request:read"]);
    await actor("creator", ["session:read", "request:read", "request:create"]);
    await actor("updater", ["session:read", "request:read", "request:update"]);
    await actor("assigner", ["session:read", "request:read", "request:assign"]);
    await actor("closer", ["session:read", "request:read", "request:close"]);
    await actor("owner-no-access", ["session:read"]);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.request.deleteMany({
      where: { incidentId: { in: incidentIds } },
    });
    await prisma.releaseAction.deleteMany({
      where: { incidentId: { in: incidentIds } },
    });
    await prisma.matchingRecord.deleteMany({
      where: { sessionId: { in: incidentIds } },
    });
    await prisma.enquiry.deleteMany({
      where: { sessionId: { in: incidentIds } },
    });
    await prisma.familyRecord.deleteMany({
      where: { sessionId: { in: incidentIds } },
    });
    await prisma.passengerRecord.deleteMany({
      where: { sessionId: { in: incidentIds } },
    });
    await prisma.caseTimelineEvent.deleteMany({
      where: { sessionId: { in: incidentIds } },
    });
    await prisma.auditLog.deleteMany({
      where: { sessionId: { in: incidentIds } },
    });
    await prisma.incidentAssignment.deleteMany({
      where: { incidentId: { in: incidentIds } },
    });
    await prisma.session.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.$disconnect();
  });

  it("deploys Request constraints, queue indexes, same-incident triggers and operation registry", async () => {
    const migrations = await prisma!.$queryRaw<
      Array<{ migration_name: string }>
    >`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    expect(migrations.map((row) => row.migration_name)).toContain(
      "20260806020000_requests_foundation",
    );
    const indexes = await prisma!.$queryRaw<
      Array<{ indexname: string }>
    >`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('WelfareRequest', 'RequestOperation')`;
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "WelfareRequest_sessionId_status_updatedAt_idx",
        "WelfareRequest_sessionId_priority_status_idx",
        "WelfareRequest_sessionId_ownerUserId_status_idx",
        "WelfareRequest_sessionId_dueAt_idx",
        "RequestOperation_incidentId_operationId_key",
      ]),
    );
    const triggers = await prisma!.$queryRaw<
      Array<{ tgname: string }>
    >`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('WelfareRequest_same_incident', 'RequestOperation_same_incident')`;
    expect(triggers).toHaveLength(2);
    const checks = await prisma!.$queryRaw<
      Array<{ conname: string }>
    >`SELECT conname FROM pg_constraint WHERE conname IN ('WelfareRequest_version_check', 'WelfareRequest_status_check', 'WelfareRequest_priority_check', 'WelfareRequest_terminal_state_check')`;
    expect(checks).toHaveLength(4);
  });

  it("persists create, ownership and human resolution across restarts with separated permissions and safe retries", async () => {
    const createOperation = randomUUID();
    expect((await createRequest(actors.reader!.email)).status).toBe(403);
    const created = await createRequest(
      actors.creator!.email,
      { priority: "High", dueAt: "2026-01-01T00:00:00.000Z" },
      createOperation,
    );
    const retriedCreate = await createRequest(
      actors.creator!.email,
      {
        priority: "High",
        dueAt: "2026-01-01T00:00:00.000Z",
        details: created.body.details,
      },
      createOperation,
    );
    expect(created.status).toBe(201);
    expect(retriedCreate.body).toMatchObject({
      id: created.body.id,
      idempotent: true,
    });
    expect(
      (
        await request(application())
          .post(`/api/requests/${created.body.id}/assign`)
          .set(as(actors.updater!.email))
          .send({})
      ).status,
    ).toBe(403);
    const assigned = await request(application())
      .post(`/api/requests/${created.body.id}/assign`)
      .set(as(actors.assigner!.email))
      .send({
        sessionId: incidentA,
        expectedVersion: created.body.version,
        ownerUserId: actors["owner-no-access"]!.id,
        reason: "Named operational owner",
      });
    expect(assigned.body).toMatchObject({
      status: "ASSIGNED",
      ownerUserId: actors["owner-no-access"]!.id,
    });
    expect(
      (
        await request(application())
          .get("/api/requests/queue")
          .query({ sessionId: incidentA })
          .set(as(actors["owner-no-access"]!.email))
      ).status,
    ).toBe(403);
    const reassigned = await request(application())
      .post(`/api/requests/${created.body.id}/assign`)
      .set(as(actors.assigner!.email))
      .send({
        sessionId: incidentA,
        expectedVersion: assigned.body.version,
        ownerUserId: coordinatorId,
        reason: "Operational handover",
      });
    expect(reassigned.body).toMatchObject({
      status: "ASSIGNED",
      ownerUserId: coordinatorId,
    });
    const resolutionOperation = randomUUID();
    const body = {
      sessionId: incidentA,
      expectedVersion: reassigned.body.version,
      outcome: "Transport arranged",
      resolutionNote: "Human operator confirmed transport completion.",
      operationId: resolutionOperation,
    };
    expect(
      (
        await request(application())
          .post(`/api/requests/${created.body.id}/resolve`)
          .set(as(actors.assigner!.email))
          .send(body)
      ).status,
    ).toBe(403);
    const resolved = await request(application())
      .post(`/api/requests/${created.body.id}/resolve`)
      .set(as(actors.closer!.email))
      .send(body);
    const retry = await request(application())
      .post(`/api/requests/${created.body.id}/resolve`)
      .set(as(actors.closer!.email))
      .send(body);
    expect(resolved.body).toMatchObject({
      status: "RESOLVED",
      resolutionOutcome: "Transport arranged",
      resolvedById: actors.closer!.id,
    });
    expect(resolved.body.resolvedAt).toBeTruthy();
    expect(retry.body).toMatchObject({ id: created.body.id, idempotent: true });
    const afterRestart = await request(application())
      .get(`/api/requests/${created.body.id}`)
      .query({ sessionId: incidentA })
      .set(as(actors.reader!.email));
    expect(afterRestart.body).toMatchObject({
      status: "RESOLVED",
      ownerUserId: coordinatorId,
      version: resolved.body.version,
    });
    const compatibility = await request(application())
      .get("/api/requests")
      .query({
        sessionId: incidentA,
        search: created.body.operationalId,
      })
      .set(as(actors.reader!.email));
    expect(compatibility.body).toMatchObject({
      deprecated: true,
      readOnly: true,
      data: [{ id: created.body.id, status: "Closed" }],
    });
    expect(
      await prisma!.requestOperation.count({
        where: { requestRecordId: created.body.id },
      }),
    ).toBe(2);
  });

  it("controls lifecycle, preserves reopen history, distinguishes cancellation and blocks generic status bypass", async () => {
    const created = await createRequest();
    expect(
      (
        await request(application())
          .patch(`/api/requests/${created.body.id}`)
          .set(as("coordinator@lot.pl"))
          .send({
            sessionId: incidentA,
            expectedVersion: created.body.version,
            status: "RESOLVED",
            resolutionOutcome: "Forged",
          })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(application())
          .post(`/api/requests/${created.body.id}/status`)
          .set(as("coordinator@lot.pl"))
          .send({ status: "Closed" })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(application())
          .delete(`/api/requests/${created.body.id}`)
          .set(as("coordinator@lot.pl"))
      ).status,
    ).toBe(404);
    const resolved = await request(application())
      .post(`/api/requests/${created.body.id}/resolve`)
      .set(as("coordinator@lot.pl"))
      .send({
        sessionId: incidentA,
        expectedVersion: created.body.version,
        outcome: "Need met",
        resolutionNote: "Human resolution was recorded.",
        operationId: randomUUID(),
      });
    const reopened = await request(application())
      .post(`/api/requests/${created.body.id}/reopen`)
      .set(as("coordinator@lot.pl"))
      .send({
        sessionId: incidentA,
        expectedVersion: resolved.body.version,
        reason: "New operational evidence requires more work.",
        operationId: randomUUID(),
      });
    expect(reopened.body).toMatchObject({
      status: "OPEN",
      resolutionOutcome: "Need met",
      resolvedAt: resolved.body.resolvedAt,
      reopenReason: "New operational evidence requires more work.",
    });
    const cancelled = await request(application())
      .post(`/api/requests/${created.body.id}/cancel`)
      .set(as("coordinator@lot.pl"))
      .send({
        sessionId: incidentA,
        expectedVersion: reopened.body.version,
        reason: "Requester withdrew the need.",
        operationId: randomUUID(),
      });
    expect(cancelled.body).toMatchObject({
      status: "CANCELLED",
      cancelReason: "Requester withdrew the need.",
      resolutionOutcome: "Need met",
    });
    expect(cancelled.body.cancelledAt).toBeTruthy();
    expect(
      await prisma!.auditLog.count({
        where: {
          entityId: created.body.id,
          action: {
            in: ["request_resolve", "request_reopen", "request_cancel"],
          },
        },
      }),
    ).toBe(3);
    expect(
      await prisma!.caseTimelineEvent.count({
        where: { entityId: created.body.id },
      }),
    ).toBe(4);
  });

  it("uses optimistic locking across operators and does not auto-retry controlled transitions", async () => {
    const created = await createRequest();
    const [resolved, assigned] = await Promise.all([
      request(application())
        .post(`/api/requests/${created.body.id}/resolve`)
        .set(as("coordinator@lot.pl"))
        .send({
          sessionId: incidentA,
          expectedVersion: created.body.version,
          outcome: "Concurrent outcome",
          resolutionNote: "Operator B resolved the Request.",
          operationId: randomUUID(),
        }),
      request(application())
        .post(`/api/requests/${created.body.id}/assign`)
        .set(as("admin@lot.pl"))
        .send({
          sessionId: incidentA,
          expectedVersion: created.body.version,
          ownerUserId: coordinatorId,
          reason: "Operator A stale assignment",
        }),
    ]);
    expect([resolved.status, assigned.status].sort()).toEqual([200, 409]);
    expect(
      await prisma!.request.count({
        where: { id: created.body.id, version: 2 },
      }),
    ).toBe(1);
  });

  it("enforces incident and cross-mode isolation, immediate revoke and closed-incident read-only behavior", async () => {
    const created = await createRequest();
    expect(
      (
        await request(application())
          .get("/api/requests/queue")
          .query({ sessionId: incidentB })
          .set(as(actors.reader!.email))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(application())
          .get(`/api/requests/${created.body.id}`)
          .query({ sessionId: incidentB })
          .set(as("admin@lot.pl"))
      ).status,
    ).toBe(404);
    await prisma!.incidentAssignment.update({
      where: { id: actors.reader!.assignmentId },
      data: {
        active: false,
        revokedAt: new Date(),
        revokedById: adminId,
        revokeReason: "Stage 7 revoke",
      },
    });
    expect(
      (
        await request(application())
          .get("/api/requests/queue")
          .query({ sessionId: incidentA })
          .set(as(actors.reader!.email))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(application())
          .get(`/api/requests/${created.body.id}`)
          .query({ sessionId: incidentA })
          .set(as(actors.reader!.email))
      ).status,
    ).toBe(403);
    await prisma!.incidentAssignment.update({
      where: { id: actors.reader!.assignmentId },
      data: {
        active: true,
        revokedAt: null,
        revokedById: null,
        revokeReason: null,
      },
    });
    const coordinatorAssignment =
      await prisma!.incidentAssignment.findFirstOrThrow({
        where: { incidentId: incidentA, userId: coordinatorId, active: true },
      });
    await prisma!.incidentAssignment.update({
      where: { id: coordinatorAssignment.id },
      data: {
        active: false,
        revokedAt: new Date(),
        revokedById: adminId,
        revokeReason: "Stage 7 full command revoke",
      },
    });
    const revokedResponses = await Promise.all([
      request(application())
        .get("/api/requests/queue")
        .query({ sessionId: incidentA })
        .set(as("coordinator@lot.pl")),
      request(application())
        .get("/api/requests/assignees")
        .query({ sessionId: incidentA })
        .set(as("coordinator@lot.pl")),
      request(application())
        .get(`/api/requests/${created.body.id}`)
        .query({ sessionId: incidentA })
        .set(as("coordinator@lot.pl")),
      request(application())
        .post("/api/requests")
        .set(as("coordinator@lot.pl"))
        .send({
          sessionId: incidentA,
          category: "Other",
          priority: "Normal",
          details: "Revoked create",
          operationId: randomUUID(),
        }),
      request(application())
        .patch(`/api/requests/${created.body.id}`)
        .set(as("coordinator@lot.pl"))
        .send({
          sessionId: incidentA,
          expectedVersion: created.body.version,
          details: "Revoked update",
        }),
      request(application())
        .post(`/api/requests/${created.body.id}/assign`)
        .set(as("coordinator@lot.pl"))
        .send({
          sessionId: incidentA,
          expectedVersion: created.body.version,
          ownerUserId: coordinatorId,
        }),
      request(application())
        .post(`/api/requests/${created.body.id}/unassign`)
        .set(as("coordinator@lot.pl"))
        .send({
          sessionId: incidentA,
          expectedVersion: created.body.version,
          reason: "Revoked unassign",
        }),
      request(application())
        .post(`/api/requests/${created.body.id}/priority`)
        .set(as("coordinator@lot.pl"))
        .send({
          sessionId: incidentA,
          expectedVersion: created.body.version,
          priority: "Urgent",
        }),
      request(application())
        .post(`/api/requests/${created.body.id}/start`)
        .set(as("coordinator@lot.pl"))
        .send({ sessionId: incidentA, expectedVersion: created.body.version }),
      request(application())
        .post(`/api/requests/${created.body.id}/wait`)
        .set(as("coordinator@lot.pl"))
        .send({ sessionId: incidentA, expectedVersion: created.body.version }),
      request(application())
        .post(`/api/requests/${created.body.id}/resolve`)
        .set(as("coordinator@lot.pl"))
        .send({
          sessionId: incidentA,
          expectedVersion: created.body.version,
          outcome: "Revoked",
          resolutionNote: "Revoked resolve",
          operationId: randomUUID(),
        }),
      request(application())
        .post(`/api/requests/${created.body.id}/reopen`)
        .set(as("coordinator@lot.pl"))
        .send({
          sessionId: incidentA,
          expectedVersion: created.body.version,
          reason: "Revoked reopen",
          operationId: randomUUID(),
        }),
      request(application())
        .post(`/api/requests/${created.body.id}/cancel`)
        .set(as("coordinator@lot.pl"))
        .send({
          sessionId: incidentA,
          expectedVersion: created.body.version,
          reason: "Revoked cancel",
          operationId: randomUUID(),
        }),
    ]);
    await prisma!.incidentAssignment.update({
      where: { id: coordinatorAssignment.id },
      data: {
        active: true,
        revokedAt: null,
        revokedById: null,
        revokeReason: null,
      },
    });
    expect(revokedResponses.map((response) => response.status)).toEqual(
      Array(revokedResponses.length).fill(403),
    );
    const closedCreate = await request(application())
      .post("/api/requests")
      .set(as("coordinator@lot.pl"))
      .send({
        sessionId: closedIncident,
        category: "Other",
        priority: "Normal",
        details: "Closed incident attempt",
        operationId: randomUUID(),
      });
    expect(closedCreate.status).toBe(409);
    const closedRow = await prisma!.request.create({
      data: {
        incidentId: closedIncident,
        operationalId: `${marker}-CLOSED-REQ`,
        category: "Other",
        priority: "Normal",
        details: "Historical closed Request",
        status: "OPEN",
        createdById: coordinatorId,
        updatedById: coordinatorId,
      },
    });
    expect(
      (
        await request(application())
          .get(`/api/requests/${closedRow.id}`)
          .query({ sessionId: closedIncident })
          .set(as("coordinator@lot.pl"))
      ).status,
    ).toBe(200);
    for (const [path, body] of [
      ["start", {}],
      ["assign", { ownerUserId: coordinatorId }],
      ["priority", { priority: "Urgent" }],
      [
        "resolve",
        {
          outcome: "No",
          resolutionNote: "Closed incident write",
          operationId: randomUUID(),
        },
      ],
      [
        "cancel",
        { reason: "Closed incident write", operationId: randomUUID() },
      ],
    ] as const) {
      expect(
        (
          await request(application())
            .post(`/api/requests/${closedRow.id}/${path}`)
            .set(as("coordinator@lot.pl"))
            .send({ sessionId: closedIncident, expectedVersion: 1, ...body })
        ).status,
      ).toBe(409);
    }
    expect(
      (
        await request(application())
          .patch(`/api/requests/${closedRow.id}`)
          .set(as("coordinator@lot.pl"))
          .send({
            sessionId: closedIncident,
            expectedVersion: 1,
            details: "Changed",
          })
      ).status,
    ).toBe(409);
  });

  it("defends same-incident references in service and PostgreSQL and keeps linked domains independent", async () => {
    const passengerA = await prisma!.passengerRecord.create({
      data: {
        operationalId: `${marker}-PAX-A`,
        sessionId: incidentA,
        personType: "Passenger",
        firstName: "Stage",
        lastName: "Seven",
        source: "Manual",
        holdStatus: "Legal hold",
        createdById: adminId,
        updatedById: adminId,
      },
    });
    const familyA = await prisma!.familyRecord.create({
      data: {
        operationalId: `${marker}-FAM-A`,
        sessionId: incidentA,
        firstName: "Family",
        lastName: "Seven",
        verificationStatus: "Unverified",
        createdById: adminId,
        updatedById: adminId,
      },
    });
    const enquiryA = await prisma!.enquiry.create({
      data: {
        operationalId: `${marker}-ENQ-A`,
        sessionId: incidentA,
        contactChannel: "Phone",
        callerName: "Caller",
        enquiryType: "Information request",
        status: "New",
        createdById: adminId,
        updatedById: adminId,
      },
    });
    const releaseA = await prisma!.releaseAction.create({
      data: {
        operationalId: `${marker}-REL-A`,
        incidentId: incidentA,
        actionType: "RELEASE",
        status: "CANCELLED",
        cancelledAt: new Date(),
        legacyImported: true,
        verificationEvidenceUnavailable: true,
        preparedById: adminId,
      },
    });
    const passengerB = await prisma!.passengerRecord.create({
      data: {
        operationalId: `${marker}-PAX-B`,
        sessionId: incidentB,
        personType: "Passenger",
        firstName: "Cross",
        lastName: "Mode",
        source: "Manual",
        createdById: adminId,
        updatedById: adminId,
      },
    });
    const familyB = await prisma!.familyRecord.create({
      data: {
        operationalId: `${marker}-FAM-B`,
        sessionId: incidentB,
        firstName: "Cross",
        lastName: "Family",
        createdById: adminId,
        updatedById: adminId,
      },
    });
    const enquiryB = await prisma!.enquiry.create({
      data: {
        operationalId: `${marker}-ENQ-B`,
        sessionId: incidentB,
        contactChannel: "Phone",
        callerName: "Cross Caller",
        enquiryType: "Information request",
        status: "New",
        createdById: adminId,
        updatedById: adminId,
      },
    });
    const releaseB = await prisma!.releaseAction.create({
      data: {
        operationalId: `${marker}-REL-B`,
        incidentId: incidentB,
        actionType: "RELEASE",
        status: "CANCELLED",
        cancelledAt: new Date(),
        legacyImported: true,
        verificationEvidenceUnavailable: true,
        preparedById: adminId,
      },
    });
    const crossReferences = [
      ["relatedPassengerRecordId", passengerB.id],
      ["relatedFamilyRecordId", familyB.id],
      ["relatedEnquiryId", enquiryB.id],
      ["relatedReleaseActionId", releaseB.id],
    ] as const;
    for (const [field, linkedId] of crossReferences) {
      expect(
        (await createRequest("admin@lot.pl", { [field]: linkedId })).status,
      ).toBe(409);
      await expect(
        prisma!.request.create({
          data: {
            incidentId: incidentA,
            operationalId: `${marker}-DIRECT-CROSS-${field}`,
            category: "Other",
            priority: "Normal",
            details: "Direct cross incident",
            [field]: linkedId,
            createdById: adminId,
            updatedById: adminId,
          },
        }),
      ).rejects.toThrow(/same incident/i);
    }
    const created = await createRequest("admin@lot.pl", {
      relatedPassengerRecordId: passengerA.id,
      relatedFamilyRecordId: familyA.id,
      relatedEnquiryId: enquiryA.id,
      relatedReleaseActionId: releaseA.id,
    });
    const restricted = await request(application())
      .get(`/api/requests/${created.body.id}`)
      .query({ sessionId: incidentA })
      .set(as(actors.reader!.email));
    expect(restricted.body).toMatchObject({
      relatedPassengerRecordId: null,
      relatedFamilyRecordId: null,
      relatedEnquiryId: null,
      relatedReleaseActionId: null,
      linkedContext: {
        passenger: null,
        family: null,
        enquiry: null,
        release: null,
      },
    });
    const before = {
      passenger: await prisma!.passengerRecord.findUniqueOrThrow({
        where: { id: passengerA.id },
      }),
      family: await prisma!.familyRecord.findUniqueOrThrow({
        where: { id: familyA.id },
      }),
      enquiry: await prisma!.enquiry.findUniqueOrThrow({
        where: { id: enquiryA.id },
      }),
      release: await prisma!.releaseAction.findUniqueOrThrow({
        where: { id: releaseA.id },
      }),
    };
    const resolved = await request(application())
      .post(`/api/requests/${created.body.id}/resolve`)
      .set(as("admin@lot.pl"))
      .send({
        sessionId: incidentA,
        expectedVersion: created.body.version,
        outcome: "Request workflow only",
        resolutionNote: "No linked domain command was invoked.",
        operationId: randomUUID(),
      });
    expect(resolved.status).toBe(200);
    expect(
      await prisma!.passengerRecord.findUniqueOrThrow({
        where: { id: passengerA.id },
      }),
    ).toMatchObject({
      version: before.passenger.version,
      holdStatus: "Legal hold",
    });
    expect(
      await prisma!.familyRecord.findUniqueOrThrow({
        where: { id: familyA.id },
      }),
    ).toMatchObject({
      version: before.family.version,
      verificationStatus: "Unverified",
    });
    expect(
      await prisma!.enquiry.findUniqueOrThrow({ where: { id: enquiryA.id } }),
    ).toMatchObject({ version: before.enquiry.version, status: "New" });
    expect(
      await prisma!.releaseAction.findUniqueOrThrow({
        where: { id: releaseA.id },
      }),
    ).toMatchObject({ version: before.release.version, status: "CANCELLED" });
  });

  it("pages and filters 1000 Requests, including overdue and owner queues", async () => {
    const dueAt = new Date("2026-01-01T00:00:00.000Z");
    await prisma!.request.createMany({
      data: Array.from({ length: 1_000 }, (_, index) => ({
        id: randomUUID(),
        operationalId: `${marker}-SCALE-${String(index).padStart(4, "0")}`,
        incidentId: incidentA,
        category: index % 2 ? "Transport" : "Accommodation",
        priority: index % 4 === 0 ? "Urgent" : "Normal",
        status: index % 5 === 0 ? "RESOLVED" : "OPEN",
        dueAt,
        resolvedAt: index % 5 === 0 ? dueAt : null,
        legacyImported: index % 5 === 0,
        ownerUserId: index % 3 === 0 ? coordinatorId : null,
        details: `Scale Request ${index}`,
        createdById: adminId,
        updatedById: adminId,
      })),
    });
    const page = await request(application())
      .get("/api/requests/queue")
      .query({
        sessionId: incidentA,
        search: `${marker}-SCALE-`,
        status: "OPEN",
        priority: "Urgent",
        due: "overdue",
        limit: 25,
        offset: 25,
        sortBy: "operationalId",
        sortDirection: "asc",
      })
      .set(as("coordinator@lot.pl"));
    expect(page.status).toBe(200);
    expect(page.body.total).toBeGreaterThan(100);
    expect(page.body.data).toHaveLength(25);
    expect(
      page.body.data.every(
        (row: any) =>
          row.overdue && row.status === "OPEN" && row.priority === "Urgent",
      ),
    ).toBe(true);
    const ownerPage = await request(application())
      .get("/api/requests/queue")
      .query({
        sessionId: incidentA,
        search: `${marker}-SCALE-`,
        ownerUserId: coordinatorId,
        limit: 10,
        offset: 0,
      })
      .set(as("coordinator@lot.pl"));
    expect(ownerPage.body.total).toBeGreaterThan(300);
    expect(ownerPage.body.data).toHaveLength(10);
  });
});

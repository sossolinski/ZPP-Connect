import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { prisma } from "../prisma.js";
import { createTechnicalReadinessRouter } from "./production-shared-router.js";

function appWith(probe: () => Promise<unknown>) {
  return express().use(createTechnicalReadinessRouter(prisma, probe));
}

describe("Stage 23 technical readiness", () => {
  it("reports PostgreSQL readiness without changing process liveness semantics", async () => {
    const response = await request(appWith(async () => [{ value: 1 }])).get("/health/readiness");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, ready: true, service: "zpp-connect-api", persistence: "postgres", database: "reachable" });
  });

  it("returns a sanitized 503 when PostgreSQL is unavailable", async () => {
    const response = await request(appWith(async () => { throw new Error("postgresql://secret:password@private-host/database"); })).get("/health/readiness");
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false, ready: false, service: "zpp-connect-api", persistence: "postgres", database: "unavailable" });
    expect(JSON.stringify(response.body)).not.toMatch(/secret|password|private-host/);
  });
});

import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createDemoRouter } from "./demo-router.js";
import { createPrismaReadinessProjectionService } from "./modules/readiness/prisma-readiness-service.js";
import { prisma } from "./prisma.js";
import type { ProductionRouteClaim } from "./routes/production-route-registry.js";

function productionApp() {
  return createApp({
    readinessService: createPrismaReadinessProjectionService(prisma),
    skipRuntimeValidation: true,
  });
}

function key(claim: ProductionRouteClaim) {
  return `${claim.method} ${claim.path.replace(/:[^/]+/g, ":param")}`;
}

describe("Stage 20 production route ownership", () => {
  it("builds PostgreSQL through the explicit production composition without collisions or memory owners", () => {
    const app = productionApp();
    const manifest = app.locals.productionRouteManifest as ProductionRouteClaim[];

    expect(app.locals.productionComposition).toBe("postgres-explicit");
    expect(app.locals.legacyMemoryRouterMounted).toBe(false);
    expect(manifest.length).toBeGreaterThan(100);
    expect(new Set(manifest.map(key)).size).toBe(manifest.length);
    expect(manifest.every((claim) => claim.memoryBacked === false)).toBe(true);
    expect(manifest.map((claim) => claim.owner)).not.toContain("demo-router");
    expect(manifest.some((claim) => claim.authority === "deferred" && claim.path === "/admin/dictionaries")).toBe(true);
  });

  it("assigns representative migrated routes to their durable domain owners", () => {
    const manifest = productionApp().locals.productionRouteManifest as ProductionRouteClaim[];
    const owner = (method: string, path: string) => manifest.find((claim) => claim.method === method && claim.path === path)?.owner;

    expect(owner("GET", "/sessions")).toBe("incidents");
    expect(owner("POST", "/requests")).toBe("requests");
    expect(owner("GET", "/sessions/:sessionId/briefings/current")).toBe("operational-briefings");
    expect(owner("POST", "/imports/:type")).toBe("imports");
    expect(owner("POST", "/exports/:type")).toBe("exports-reports");
    expect(owner("POST", "/exercise/injects")).toBe("exercise");
    expect(owner("GET", "/readiness/summary")).toBe("readiness");
    expect(owner("GET", "/dashboard")).toBe("production-shared");
    expect(owner("GET", "/timeline")).toBe("production-shared");
  });

  it("keeps the generic demo composition available only for intentional memory tests", () => {
    const app = createApp({ skipRuntimeValidation: true });
    expect(app.locals.productionComposition).toBe("memory-test-only");
    expect(app.locals.legacyMemoryModuleLoaded).toBe(true);
    expect(app.locals.legacyMemoryRouterMounted).toBe(true);
    expect(app.locals.productionRouteManifest).toBeUndefined();
    expect(() => createDemoRouter({ incidentRepository: { kind: "postgres" } as any })).toThrow(/test-memory-only/);
  });
});

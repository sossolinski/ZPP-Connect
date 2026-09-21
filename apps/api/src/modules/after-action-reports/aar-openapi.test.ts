import { describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../prisma.js";
import { openApiDocument } from "../../openapi.js";
import type { ProductionRouteClaim } from "../../routes/production-route-registry.js";
import { createPrismaAfterActionReportService } from "./prisma-after-action-report-service.js";
import { aarOpenApiPaths } from "./aar-openapi.js";

describe("Stage 22 OpenAPI contract", () => {
  it("documents every AAR production method/path exactly once with schemas and real status codes", () => {
    const app = createApp({ afterActionReportService: createPrismaAfterActionReportService(prisma), skipRuntimeValidation: true });
    const routes = (app.locals.productionRouteManifest as ProductionRouteClaim[]).filter(r => r.owner === "after-action-reports")
      .map(r => r.method + " " + r.path.replace(/:([a-zA-Z]+)/g, "{$1}")).sort();
    const documented = Object.entries(aarOpenApiPaths).flatMap(([path, methods]) => Object.keys(methods).map(method => method.toUpperCase() + " " + path)).sort();
    expect(documented).toEqual(routes); expect(routes).toHaveLength(16);
    expect(aarOpenApiPaths["/after-action-report-versions/{id}/approve"].post.responses).not.toHaveProperty("201");
    expect(aarOpenApiPaths["/after-action-report-versions/{id}/pdf-artifacts"].post.responses).toHaveProperty("201");
    for (const [path, methods] of Object.entries(aarOpenApiPaths)) for (const op of Object.values(methods)) {
      const response = op.responses["200"] as unknown as { content: Record<string, unknown> };
      expect(response.content).toHaveProperty(path.endsWith("/download") ? "application/pdf" : "application/json");
    }
  });
  it("resolves every local schema reference and defines PDF integrity failure without binary content", () => {
    const schemas = openApiDocument.components.schemas as Record<string, unknown>;
    function walk(value: unknown) {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref") expect(schemas).toHaveProperty(String(child).split("/").at(-1)!);
        else walk(child);
      }
    }
    walk(aarOpenApiPaths); walk(schemas);
    const failure = aarOpenApiPaths["/after-action-pdf-artifacts/{id}/download"].get.responses["500"] as unknown as { content: object };
    expect(failure.content).toHaveProperty("application/json"); expect(failure.content).not.toHaveProperty("application/pdf");
  });
});

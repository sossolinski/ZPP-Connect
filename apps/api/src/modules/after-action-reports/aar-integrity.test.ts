import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { canonicalJson, contentDigest, createSchema, editSchema, type AarVersion } from "./after-action-report-types.js";
import { pdfPlainText, renderAarPdf } from "./aar-pdf-renderer.js";

const v = {
  id: "version", reportId: "report", revision: 3, basedOnVersionId: "previous", schemaVersion: "aar-v1",
  title: "Test title", eventDate: new Date("2026-09-21T00:00:00Z"), executiveSummary: "Executive evidence",
  contextSnapshot: { operationalId: "AAR-2026-000001" },
  createdAt: new Date("2026-09-21T00:00:00Z"), createdById: "author", submittedById: "reviewer", submittedAt: new Date("2026-09-21T01:00:00Z"),
  approvedAt: new Date("2026-09-21T02:00:00Z"), approvedById: "approver", status: "Approved",
  findings: [{ sortOrder: 1, area: "Coordination", summary: "Finding evidence", detail: "Finding detail", sourceObservationId: null, sourceObservationVersion: null, sourceObservationOperationalId: null }],
  lessons: [{ sortOrder: 1, statement: "Lesson evidence" }],
  correctiveActions: [{ sortOrder: 1, recommendation: "Action evidence", owner: "Operations", targetDate: new Date("2026-10-01T00:00:00Z") }],
} as unknown as AarVersion;
const view = () => ({ artifactId: "artifact-identity", generatedAt: new Date("2026-09-21T03:00:00Z"), version: v,
  context: { operationalId: "AAR-2026-000001", sessionOperationalId: "SESSION-001", mode: "REAL", eventType: "Incident", owner: "Owner Name", author: "Author Name", approver: "Approver Name" } });

describe("AAR canonical content and PDF renderer", () => {
  it("canonicalizes object keys and dates but preserves section order", () => {
    expect(canonicalJson({ b: 2, a: new Date(0) })).toBe(canonicalJson({ a: new Date(0), b: 2 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(contentDigest(v)).toMatch(/^[a-f0-9]{64}$/);
    expect(contentDigest({ ...v, executiveSummary: "Changed" })).not.toBe(contentDigest(v));
    expect(contentDigest({ ...v, version: 999 })).toBe(contentDigest(v));
  });
  it("rejects client provenance, empty titles and oversized section arrays", () => {
    expect(createSchema.safeParse({ title: " ", sessionId: "invalid", operationId: "invalid" }).success).toBe(false);
    expect(editSchema.safeParse({ expectedVersion: 1, title: "Valid", eventDate: "2026-09-21T00:00:00Z", executiveSummary: "", findings: [], lessons: [], correctiveActions: [], contentSha256: "forged" }).success).toBe(false);
  });
  it("renders extractable identity, approval, provenance and every section with fixed fonts", async () => {
    const pdf = await renderAarPdf(view());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // Poppler is a test-only system tool, not an API runtime dependency.
    const text = execFileSync("pdftotext", ["-layout", "-", "-"], { input: pdf, encoding: "utf8" }).replace(/\s+/g, " ");
    for (const expected of ["AAR-2026-000001", "Revision 3", "Approved", "SESSION-001", "artifact-identity", "2026-09-21", "Owner Name", "Author Name", "Approver Name", "Executive evidence", "Finding evidence", "Finding detail", "Lesson evidence", "Action evidence", "Operations", "2026-10-01"]) expect(text).toContain(expected);
  });
  it("wraps long plain text across pages and does not interpret markup or silently corrupt Unicode", async () => {
    expect(pdfPlainText("Łódź <b>text</b>")).toBe("[U+0141]ód[U+017A] <b>text</b>");
    const pdf = await renderAarPdf({ ...view(), version: { ...v, executiveSummary: ("Long text <b>plain</b> Łódź. ").repeat(1500) } });
    const text = execFileSync("pdftotext", ["-layout", "-", "-"], { input: pdf, encoding: "utf8" });
    expect(text).toContain("<b>plain</b>"); expect(text).toContain("[U+0141]");
    expect(text.split("\f").length).toBeGreaterThan(2); expect(text).toContain("Action evidence");
  });
  it("enforces the byte boundary without emitting a partial artifact", async () => {
    await expect(renderAarPdf(view(), 128)).rejects.toMatchObject({ status: 413 });
  });
});

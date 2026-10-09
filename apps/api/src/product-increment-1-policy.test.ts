import { describe, expect, it } from "vitest";
import { ageLabel, briefingUpdateState, assertDashboardDto } from "@zpp/shared";
import { dashboardAttention } from "./modules/dashboard/dashboard-attention.js";

describe("PI1 operational status policies", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  it("qualifies historical publication and scheduled, overdue and absent update times", () => {
    expect(ageLabel("2026-10-09T11:45:00Z", now)).toBe("15 min ago");
    expect(ageLabel("2026-10-06T12:00:00Z", now)).toBe("3 days ago");
    expect(briefingUpdateState("2026-10-09T14:00:00+02:00", now)).toBe("scheduled");
    expect(briefingUpdateState("2026-10-09T13:59:00+02:00", now)).toBe("overdue");
    expect(briefingUpdateState(null, now)).toBe("unscheduled");
  });
  it("rejects omitted and malformed availability instead of treating them as zero", () => {
    expect(() => assertDashboardDto({})).toThrow(/could not be verified/);
    const valid = { operationalStatus: { loadedAt: "2026-10-09T12:00:00Z", specialist: { status: "unavailable" }, attention: { status: "unavailable" } } };
    expect(() => assertDashboardDto(valid)).not.toThrow();
    expect(() => assertDashboardDto({ operationalStatus: { ...valid.operationalStatus, specialist: { status: "unavailable", value: 0 } } })).toThrow();
    expect(() => assertDashboardDto({ operationalStatus: { ...valid.operationalStatus, specialist: { status: "available", value: {} } } })).toThrow();
  });
  it("distinguishes unavailable from measured empty and deduplicates overlapping issues", () => {
    expect(dashboardAttention([])).toEqual({ status: "unavailable" });
    expect(dashboardAttention([{ label: "My work", items: [] }])).toMatchObject({ status: "available", value: { items: [] } });
    const item = { key: "match:one", title: "MAT-1", detail: "Hold", href: "/matching" };
    expect(dashboardAttention([{ label: "Holds", items: [item] }, { label: "Review", items: [{ ...item, detail: "Pending review" }] }])).toMatchObject({ value: { items: [{ ...item, detail: "Hold · Pending review" }] } });
  });
});

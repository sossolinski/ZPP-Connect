import { describe, expect, it } from "vitest";
import { assertIncidentWorkspace, type IncidentWorkspace } from "@zpp/shared";
import { operationalActivityText } from "./modules/workspace/incident-workspace-reader.js";

function empty(): IncidentWorkspace {
  const unavailable = { status: "unavailable" } as const;
  return { incident: { operationalId: "INC-1", name: "Synthetic incident", description: null, status: "Active", location: null, flight: null, route: null, roles: [] }, briefing: { status: "available", value: null }, myTasks: { status: "available", value: { items: [], total: 0, limit: 6, scope: "Your tasks" } }, myRequests: unavailable, teamTasks: unavailable, teamRequests: unavailable, coverage: unavailable, activity: unavailable };
}
describe("PI2 touched workspace boundary", () => {
  it("keeps measured empty personal work distinct from unavailable team work", () => {
    const data = empty(); expect(() => assertIncidentWorkspace(data)).not.toThrow();
    expect(data.myTasks.status).toBe("available"); expect(data.teamTasks).not.toHaveProperty("value");
  });
  it("rejects absent and malformed sections rather than inventing no work", () => {
    const data = empty(); expect(() => assertIncidentWorkspace({ ...data, myTasks: undefined })).toThrow();
    expect(() => assertIncidentWorkspace({ ...data, myTasks: { status: "available", value: { items: [], limit: 6, scope: "mine" } } })).toThrow();
    expect(() => assertIncidentWorkspace({ ...data, teamTasks: { status: "unavailable", value: 0 } })).toThrow();
  });
  it("rejects unsafe source links and invalid staffing periods", () => {
    const data = empty(); const coverage = { status: "available", value: { total: 1, limit: 6, scope: "current", items: [{ id: "1", title: "Duty", functionName: "Coordinator", person: null, group: null, location: "Airport", startAt: "invalid", endAt: "invalid", state: "Unfilled duty", href: "//external.example" }] } };
    expect(() => assertIncidentWorkspace({ ...data, coverage })).toThrow();
  });
  it("preserves operational meaning without displaying technical identifiers", () => {
    const uuid = "1a2b3c4d-1234-4321-1234-123456789abc", hash = "a".repeat(64);
    const text = operationalActivityText(`Assignment ASN-42 escalated by replacement operator; ${uuid} ${hash} s3://private/key`);
    expect(text).toContain("Task ASN-42 escalated by replacement operator"); expect(text).not.toContain(uuid); expect(text).not.toContain(hash); expect(text).not.toContain("private/key");
  });
});

import { describe, expect, it } from "vitest";
import { decisionSchema, releaseDecisionSchema, requestStatusSchema, requestStatusUpdateSchema, sessionCloseSchema } from "./validation.js";

describe("workflow validation", () => {
  it("accepts terminal request statuses used by dashboards", () => {
    expect(requestStatusSchema.parse("Done")).toBe("Done");
    expect(requestStatusSchema.parse("Closed")).toBe("Closed");
  });

  it("rejects unknown request statuses", () => {
    expect(() => requestStatusSchema.parse("Mostly finished")).toThrow();
  });

  it("rejects unknown hold types in decisions", () => {
    expect(() =>
      decisionSchema.parse({
        decisionNotes: "Hold requires review.",
        holdCheck: "Mystery hold"
      })
    ).toThrow();
  });

  it("requires meaningful decision notes for operational closures", () => {
    expect(sessionCloseSchema.parse({ notes: "Closure confirmed." }).notes).toBe("Closure confirmed.");
    expect(() => sessionCloseSchema.parse({ notes: "  " })).toThrow();
    expect(() => requestStatusUpdateSchema.parse({ status: "Closed" })).toThrow();
    expect(requestStatusUpdateSchema.parse({ status: "Closed", closureNote: "Resolved by ZPP." }).closureNote).toBe("Resolved by ZPP.");
    expect(releaseDecisionSchema.parse({ notes: "Released to approved receiving party." }).notes).toBe("Released to approved receiving party.");
    expect(() => releaseDecisionSchema.parse({ notes: "ok" })).toThrow();
  });
});

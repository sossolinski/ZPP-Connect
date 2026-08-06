import { describe, expect, it } from "vitest";
import { sessionCloseSchema } from "./validation.js";

describe("workflow validation", () => {
  it("requires meaningful decision notes for incident closures", () => {
    expect(sessionCloseSchema.parse({ notes: "Closure confirmed." }).notes).toBe("Closure confirmed.");
    expect(() => sessionCloseSchema.parse({ notes: "  " })).toThrow();
  });
});

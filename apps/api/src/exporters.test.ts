import { describe, expect, it } from "vitest";
import { parseWorkbook, workbookBuffer } from "./exporters.js";

describe("CSV import/export helpers", () => {
  it("parses quoted CSV cells", () => {
    const rows = parseWorkbook(Buffer.from('firstName,lastName,notes\n"Anna","Kowalska","needs, callback"\n'), "family.csv");

    expect(rows).toEqual([
      {
        firstName: "Anna",
        lastName: "Kowalska",
        notes: "needs, callback"
      }
    ]);
  });

  it("exports multiple sections as CSV rows", () => {
    const buffer = workbookBuffer({
      Enquiries: [{ operationalId: "TEC-1", status: "New" }],
      Requests: [{ operationalId: "REQ-1", status: "Done" }]
    });

    const csv = buffer.toString("utf8");
    expect(csv).toContain("section,operationalId,status");
    expect(csv).toContain("Enquiries,TEC-1,New");
    expect(csv).toContain("Requests,REQ-1,Done");
  });
});

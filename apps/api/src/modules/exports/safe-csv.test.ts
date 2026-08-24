import { describe, expect, it } from "vitest";
import { csvCell, serializeCsvSections } from "./safe-csv.js";

describe("Stage 17 safe CSV", () => {
  it("neutralizes spreadsheet formula strings without corrupting typed negative numbers", () => {
    for (const value of ['=HYPERLINK("https://example.invalid","click")', "=1+1", "+cmd", "@SUM(1,1)", "\t=1+1", "\r=1+1", "  =1+1", "-12"]) {
      expect(csvCell(value)).toMatch(/^['"]|^"'/);
    }
    expect(csvCell(-12)).toBe("-12");
    expect(csvCell(false)).toBe("false");
  });

  it("keeps explicit deterministic columns and valid quoting for commas, quotes, newlines and Unicode", () => {
    const buffer = serializeCsvSections([{ name: "Safe", columns: [{ key: "name" }, { key: "notes" }], rows: [{ name: "Zażółć", notes: 'comma, quote " and\nline' }] }]);
    expect(buffer.toString("utf8")).toBe('section,name,notes\nSafe,Zażółć,"comma, quote "" and\nline"\n');
  });
});

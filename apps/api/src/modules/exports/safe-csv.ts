export type CsvColumn = { key: string };
export type CsvSection = {
  name: string;
  columns: readonly CsvColumn[];
  rows: Array<Record<string, unknown>>;
};

function stringCell(value: string) {
  return /^[\t\r\n ]*[=+\-@]/.test(value) || /^[\t\r]/.test(value) ? `'${value}` : value;
}

export function csvCell(value: unknown) {
  let text = "";
  if (typeof value === "string") text = stringCell(value);
  else if (value instanceof Date) text = value.toISOString();
  else if (value !== null && value !== undefined) text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeCsvSections(sections: CsvSection[]) {
  const headers = ["section"];
  for (const section of sections) {
    for (const column of section.columns) {
      if (!headers.includes(column.key)) headers.push(column.key);
    }
  }
  const lines = [headers.map(csvCell).join(",")];
  for (const section of sections) {
    const keys = new Set(section.columns.map((column) => column.key));
    for (const row of section.rows) {
      lines.push(headers.map((header) => header === "section" ? csvCell(section.name) : keys.has(header) ? csvCell(row[header]) : "").join(","));
    }
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

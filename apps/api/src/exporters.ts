import PDFDocument from "pdfkit";

export function workbookBuffer(sheets: Record<string, unknown[]>) {
  const outputRows: Array<Record<string, unknown>> = [];
  for (const [name, sheetRows] of Object.entries(sheets)) {
    for (const row of sheetRows) {
      outputRows.push({ section: name, ...(row as Record<string, unknown>) });
    }
  }
  return Buffer.from(csvString(outputRows), "utf8");
}

export function parseWorkbook(buffer: Buffer, fileName: string) {
  if (!fileName.toLowerCase().endsWith(".csv")) {
    throw new Error("Only CSV files are supported for imports");
  }
  const parsed = parseCsv(buffer.toString("utf8").replace(/^\uFEFF/, ""));
  const [headers = [], ...bodyRows] = parsed;
  return bodyRows
    .filter((row) => row.some((value) => value.trim() !== ""))
    .map((row) =>
      Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]))
    ) as Record<string, unknown>[];
}

export async function pdfSummaryBuffer(input: {
  title: string;
  subtitle: string;
  lines: Array<[string, string | number]>;
  sections: Array<{ title: string; rows: Array<Record<string, unknown>> }>;
}) {
  const doc = new PDFDocument({ margin: 48, size: "A4" });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  doc.fontSize(18).text(input.title);
  doc.moveDown(0.25);
  doc.fontSize(10).fillColor("#475569").text(input.subtitle);
  doc.moveDown();

  doc.fillColor("#0f172a").fontSize(11);
  for (const [label, value] of input.lines) {
    doc.text(`${label}: ${value}`);
  }

  for (const section of input.sections) {
    doc.moveDown();
    doc.fontSize(13).text(section.title);
    doc.moveDown(0.25);
    if (section.rows.length === 0) {
      doc.fontSize(10).fillColor("#64748b").text("No records.");
      doc.fillColor("#0f172a");
      continue;
    }
    for (const row of section.rows.slice(0, 20)) {
      const line = Object.entries(row)
        .slice(0, 6)
        .map(([key, value]) => `${key}: ${String(value ?? "")}`)
        .join(" | ");
      doc.fontSize(9).fillColor("#0f172a").text(line, { width: 500 });
    }
  }

  doc.end();

  return new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export function normalizeRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "").replace(/^_+|_+$/g, ""),
      typeof value === "string" ? value.trim() : value
    ])
  ) as Record<string, unknown>;
}

function csvEscape(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvString(rows: Array<Record<string, unknown>>) {
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const lines = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))
  ];
  return `${lines.join("\n")}\n`;
}

function detectDelimiter(line: string) {
  const candidates = [",", ";", "\t"];
  return candidates
    .map((delimiter) => ({ delimiter, count: line.split(delimiter).length }))
    .sort((left, right) => right.count - left.count)[0]?.delimiter ?? ",";
}

function parseCsv(input: string) {
  const delimiter = detectDelimiter(input.split(/\r?\n/, 1)[0] ?? "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    const next = input[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

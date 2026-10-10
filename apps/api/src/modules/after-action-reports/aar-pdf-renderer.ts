import PDFDocument from "pdfkit";
import { HttpError } from "../../errors.js";
import { aarPdfLimit, type AarVersion } from "./after-action-report-types.js";

export type AarPdfView = {
  artifactId: string; generatedAt: Date; version: AarVersion;
  context: { operationalId: string; sessionOperationalId: string; mode: string; eventType: string; owner: string; author: string; approver: string };
};
// Built-in PDF fonts cannot represent arbitrary Unicode. Preserve unsupported
// code points visibly instead of silently generating incorrect glyphs.
export function pdfPlainText(value: string) {
  return Array.from(value).map(c => {
    const n = c.codePointAt(0)!;
    return n === 10 || n === 9 || (n >= 32 && n <= 126) || (n >= 160 && n <= 255) ? c : "[U+" + n.toString(16).toUpperCase().padStart(4, "0") + "]";
  }).join("");
}
export function renderAarPdf(view: AarPdfView, byteLimit = aarPdfLimit): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 48, right: 48, bottom: 72, left: 48 }, bufferPages: true, info: { Title: view.version.title, Creator: "ZPP Connect aar-pdf-v1", CreationDate: view.generatedAt } });
    const chunks: Buffer[] = [];
    let size = 0;
    doc.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > byteLimit) { chunks.length = 0; reject(new HttpError(413, "AAR PDF exceeds the 10 MiB limit")); return; }
      chunks.push(chunk);
    });
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    const heading = (value: string) => { if (doc.y > 710) doc.addPage(); doc.moveDown().font("Helvetica-Bold").fontSize(13).text(pdfPlainText(value)); doc.font("Helvetica").fontSize(10); };
    const line = (value: string) => doc.text(pdfPlainText(value), { width: 495 });
    const { version: v, context: c } = view;
    doc.font("Helvetica-Bold").fontSize(20).text("After Action Report");
    doc.font("Helvetica").fontSize(10);
    line(c.operationalId + " / Revision " + v.revision + " / Approved");
    line("Artifact: " + view.artifactId);
    line("Template: aar-pdf-v1");
    line("Unsupported font characters are preserved as [U+codepoint].");
    line("Session: " + c.sessionOperationalId + " / " + c.mode + " / " + c.eventType);
    line("Event date: " + v.eventDate.toISOString());
    line("Owner: " + c.owner + " / Author: " + c.author);
    line("Approved by: " + c.approver + " / " + v.approvedAt!.toISOString());
    line("Generated: " + view.generatedAt.toISOString());
    heading(v.title);
    heading("Executive Summary"); line(v.executiveSummary);
    heading("Findings");
    for (const f of v.findings) {
      line(f.sortOrder + ". [" + f.area + "] " + f.summary);
      if (f.detail) line(f.detail);
      if (f.sourceObservationOperationalId) line("Source: " + f.sourceObservationOperationalId + " v" + f.sourceObservationVersion);
      doc.moveDown(0.5);
    }
    heading("Lessons Identified");
    for (const l of v.lessons) { line(l.sortOrder + ". " + l.statement); doc.moveDown(0.5); }
    heading("Corrective Actions / Recommendations");
    for (const a of v.correctiveActions) {
      line(a.sortOrder + ". " + a.recommendation);
      if (a.owner) line("Owner: " + a.owner);
      if (a.targetDate) line("Target: " + a.targetDate.toISOString().slice(0, 10));
      doc.moveDown(0.5);
    }
    const pages = doc.bufferedPageRange();
    for (let n = 0; n < pages.count; n++) {
      doc.switchToPage(n);
      doc.fontSize(8).text(c.operationalId + " / r" + v.revision + " / " + (n + 1) + " of " + pages.count, 48, 790, { lineBreak: false });
    }
    doc.end();
  });
}

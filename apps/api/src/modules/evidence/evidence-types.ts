import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { HttpError } from "../../errors.js";

export const evidenceCategories = [
  "Photograph",
  "Scanned document",
  "Authority correspondence",
  "Operational evidence",
  "External report",
  "Reference",
] as const;

export type EvidenceCategory = typeof evidenceCategories[number];
export type EvidenceActor = { id: string; email: string; displayName: string; requestId?: string };

const mimeExtensions: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "text/plain": [".txt"],
};

export function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedFilename(value: string) {
  return [...value].slice(0, 255).join("");
}

export function normalizeEvidenceFilename(value: string, fallbackExtension = ".bin") {
  let supplied = String(value ?? "");
  // RFC 7578 leaves multipart filename encoding underspecified. Busboy exposes
  // UTF-8 filename bytes as Latin-1 on some clients; repair only that detectable
  // case and still neutralize every C0/C1 control character below.
  if (/[\u0080-\u009f]/.test(supplied) && [...supplied].every(character => character.charCodeAt(0) <= 0xff)) {
    const decoded = Buffer.from(supplied, "latin1").toString("utf8");
    if (!decoded.includes("\ufffd")) supplied = decoded;
  }
  const leaf = supplied.normalize("NFC").replaceAll("\\", "/").split("/").at(-1) ?? "";
  const originalFileName = boundedFilename(leaf.replace(/[\u0000-\u001f\u007f-\u009f]/g, "_").trim()) || `evidence${fallbackExtension}`;
  const fileName = boundedFilename(originalFileName.replace(/["';]/g, "_").replace(/\s+/g, " ").trim()) || `evidence${fallbackExtension}`;
  return { originalFileName, fileName };
}

function startsWith(bytes: Buffer, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

function isSafeUtf8Text(bytes: Buffer) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0") || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return false;
    const prefix = text.trimStart().slice(0, 80).toLowerCase();
    return !prefix.startsWith("#!") && !prefix.startsWith("<script") && !prefix.startsWith("<!doctype html") && !prefix.startsWith("<html");
  } catch {
    return false;
  }
}

export function detectEvidenceMime(bytes: Buffer) {
  if (!bytes.length) throw new HttpError(400, "Evidence file must not be empty");
  if (startsWith(bytes, [0x4d, 0x5a]) || startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(bytes, [0x23, 0x21])) {
    throw new HttpError(400, "Executable evidence files are not allowed");
  }
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (isSafeUtf8Text(bytes)) return "text/plain";
  throw new HttpError(400, "Evidence content type is not allowed");
}

export function validateEvidenceUpload(input: {
  bytes: Buffer;
  originalName: string;
  declaredMimeType: string;
  maxBytes: number;
}) {
  if (input.bytes.length > input.maxBytes) throw new HttpError(400, `Evidence file must not exceed ${input.maxBytes} bytes`);
  const mimeType = detectEvidenceMime(input.bytes);
  const declaredMimeType = input.declaredMimeType.toLowerCase().split(";", 1)[0]!.trim();
  if (declaredMimeType !== mimeType) throw new HttpError(400, "Declared evidence type does not match file content");
  const extension = mimeExtensions[mimeType]![0]!;
  const names = normalizeEvidenceFilename(input.originalName, extension);
  if (!mimeExtensions[mimeType]!.some((candidate) => names.originalFileName.toLowerCase().endsWith(candidate))) {
    throw new HttpError(400, "Evidence filename extension does not match file content");
  }
  return { ...names, mimeType, declaredMimeType, sizeBytes: input.bytes.length, contentSha256: sha256(input.bytes) };
}

export function evidenceStorageKey(id: string) {
  const key = `incident-evidence/${id.toLowerCase()}`;
  assertEvidenceStorageKey(key);
  return key;
}

export function assertEvidenceStorageKey(value: string) {
  if (!/^incident-evidence\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("Unsafe incident evidence storage key");
  }
  return value;
}

function asciiFilename(value: string) {
  const normalized = value.normalize("NFKD").replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_").replace(/\s+/g, " ").trim();
  return normalized.slice(0, 180) || "evidence";
}

export function evidenceContentDisposition(fileName: string) {
  const fallback = asciiFilename(fileName);
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export interface EvidenceScanner {
  scan(input: { bytes: Buffer; mimeType: string; contentSha256: string }): Promise<{ status: "NOT_CONFIGURED" }>;
}

export const unconfiguredEvidenceScanner: EvidenceScanner = {
  async scan() { return { status: "NOT_CONFIGURED" }; },
};

import { describe, expect, it } from "vitest";
import { assertEvidenceStorageKey, detectEvidenceMime, evidenceContentDisposition, evidenceStorageKey, normalizeEvidenceFilename, sha256, validateEvidenceUpload } from "./evidence-types.js";

describe("incident evidence safety primitives", () => {
  it("uses only deterministic opaque UUID storage keys", () => {
    expect(evidenceStorageKey("550E8400-E29B-41D4-A716-446655440000")).toBe("incident-evidence/550e8400-e29b-41d4-a716-446655440000");
    for (const unsafe of ["../secret", "incident-evidence/../secret", "/tmp/file", "incident-evidence/not-a-uuid"]) {
      expect(() => assertEvidenceStorageKey(unsafe)).toThrow("Unsafe incident evidence storage key");
    }
  });

  it("produces stable SHA-256 digests", () => {
    expect(sha256(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("normalizes path-like, quoted, Unicode and control-character filenames", () => {
    expect(normalizeEvidenceFilename('../../folder\\zażółć "raport"\n.pdf')).toEqual({
      originalFileName: 'zażółć "raport"_.pdf', fileName: "zażółć _raport__.pdf",
    });
    const header = evidenceContentDisposition('zażółć "report";\r\nX-Evil: yes.pdf');
    expect(header).not.toContain("\r"); expect(header).not.toContain("\n");
    expect(header).toContain("filename*=UTF-8''");
  });

  it("sniffs allowed content and rejects executables, scripts and MIME spoofing", () => {
    expect(detectEvidenceMime(Buffer.from("%PDF-1.4\n%%EOF"))).toBe("application/pdf");
    expect(detectEvidenceMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    for (const bytes of [Buffer.from("MZprogram"), Buffer.from("#!/bin/sh"), Buffer.from("<script>alert(1)</script>"), Buffer.from([0, 1, 2])]) {
      expect(() => detectEvidenceMime(bytes)).toThrow();
    }
    expect(() => validateEvidenceUpload({ bytes: Buffer.from("%PDF-1.4\n%%EOF"), originalName: "spoof.jpg", declaredMimeType: "image/jpeg", maxBytes: 1024 })).toThrow("Declared evidence type");
  });

  it("enforces empty, extension and configured size boundaries", () => {
    expect(() => validateEvidenceUpload({ bytes: Buffer.alloc(0), originalName: "empty.txt", declaredMimeType: "text/plain", maxBytes: 10 })).toThrow("must not be empty");
    expect(() => validateEvidenceUpload({ bytes: Buffer.from("plain text"), originalName: "note.pdf", declaredMimeType: "text/plain", maxBytes: 100 })).toThrow("extension");
    expect(() => validateEvidenceUpload({ bytes: Buffer.from("plain text"), originalName: "note.txt", declaredMimeType: "text/plain", maxBytes: 2 })).toThrow("must not exceed");
  });
});

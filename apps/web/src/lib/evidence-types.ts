export type EvidenceRecord = {
  id: string;
  operationalId: string;
  sessionId: string;
  originalFileName: string;
  fileName: string;
  mimeType: string;
  declaredMimeType: string;
  sizeBytes: number;
  contentSha256: string;
  category: string;
  description: string | null;
  status: "Active" | "Withdrawn";
  scanStatus: "NOT_CONFIGURED";
  version: number;
  createdAt: string;
  createdBy: { id: string; displayName: string; email: string };
  withdrawnAt: string | null;
  withdrawalReason: string | null;
  withdrawnBy: { id: string; displayName: string; email: string } | null;
  replayed?: boolean;
};

export type EvidencePage = { data: EvidenceRecord[]; total: number; limit: number; offset: number };


import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

const delegates = {
  session: prisma.session,
  enquiry: prisma.enquiry,
  familyRecord: prisma.familyRecord,
  passengerRecord: prisma.passengerRecord,
  matchingRecord: prisma.matchingRecord,
  request: prisma.request,
  assignmentTask: prisma.assignmentTask,
  importBatch: prisma.importBatch,
  storedFile: prisma.storedFile,
  exerciseInject: prisma.exerciseInject,
  exerciseObservation: prisma.exerciseObservation
} as const;

type DelegateName = keyof typeof delegates;

export async function nextOperationalId(model: DelegateName, prefix: string, digits = 6) {
  const year = new Date().getFullYear();
  const stem = `${prefix}-${year}-`;
  const delegate = delegates[model] as { count(args: unknown): Promise<number> };
  const count = await delegate.count({ where: { operationalId: { startsWith: stem } } });
  return `${stem}${String(count + 1).padStart(digits, "0")}`;
}

export async function nextSessionId() {
  const [row] = await prisma.$queryRaw<Array<{ value: bigint }>>`
    SELECT nextval('"Session_operational_seq"') AS value
  `;
  return `SES-${new Date().getFullYear()}-${String(row!.value).padStart(3, "0")}`;
}

function isOperationalIdConflict(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2002") return false;
  const target = error.meta?.target;
  return Array.isArray(target) ? target.includes("operationalId") : String(target ?? "").includes("operationalId");
}

export async function withOperationalIdRetry<T>(operation: () => Promise<T>, attempts = 5) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isOperationalIdConflict(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

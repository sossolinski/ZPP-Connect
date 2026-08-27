import type { Dictionary } from "@prisma/client";

export type DictionaryClassification = "P" | "E" | "L" | "D" | "X";
export type DictionaryAuthority = "code" | "postgres";

export type DictionaryPolicy = {
  category: string;
  classification: DictionaryClassification;
  authority: DictionaryAuthority;
  protected: boolean;
  allowCreate: boolean;
  allowLabelEdit: boolean;
  allowDescriptionEdit: boolean;
  allowReorder: boolean;
  allowDeactivate: boolean;
  allowReactivate: boolean;
  keyImmutable: true;
  participatesInHistoricalRecords: boolean;
  inactiveValuesRemainReadable: boolean;
  publicExposed: boolean;
  limits: {
    key: number;
    label: number;
    description: number;
    sortOrder: number;
  };
  reason: string;
};

export type DictionaryActor = {
  id: string;
  email: string;
  displayName: string;
};

export type DictionaryAdminRecord = Dictionary & {
  policy: DictionaryPolicy;
};

export type PublicDictionaryItem = {
  id: string;
  category: string;
  key: string;
  label: string;
  sortOrder: number;
  isActive: true;
};

export type DictionaryPage = {
  total: number;
  limit: number;
  offset: number;
  data: DictionaryAdminRecord[];
};

export type DictionaryFailurePoint =
  | "beforeMutation"
  | "afterMutationBeforeAudit"
  | "duringAudit"
  | "beforeCommit";

export interface DictionaryConfigurationService {
  readonly kind: "postgres";
  listAdmin(query: {
    category?: string;
    active?: boolean;
    search?: string;
    limit: number;
    offset: number;
  }): Promise<DictionaryPage>;
  publicDictionaries(): Promise<Record<string, PublicDictionaryItem[]>>;
  create(input: {
    category: string;
    key: string;
    label: string;
    description?: string | null;
    sortOrder?: number;
  }, actor: DictionaryActor): Promise<DictionaryAdminRecord>;
  update(id: string, input: {
    expectedVersion: number;
    label?: string;
    description?: string | null;
    sortOrder?: number;
  }, actor: DictionaryActor): Promise<DictionaryAdminRecord>;
  setActive(id: string, input: { expectedVersion: number; active: boolean }, actor: DictionaryActor): Promise<DictionaryAdminRecord>;
  assertActiveLabel(category: string, label: string): Promise<void>;
}

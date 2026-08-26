import { dictionaries } from "@zpp/shared";
import type { DictionaryPolicy } from "./configuration-types.js";

const limits = { key: 80, label: 200, description: 1_000, sortOrder: 1_000_000 } as const;

function protectedPolicy(category: string, reason: string): DictionaryPolicy {
  return {
    category,
    classification: "P",
    authority: "code",
    protected: true,
    allowCreate: false,
    allowLabelEdit: false,
    allowDescriptionEdit: false,
    allowReorder: false,
    allowDeactivate: false,
    allowReactivate: false,
    keyImmutable: true,
    participatesInHistoricalRecords: true,
    inactiveValuesRemainReadable: true,
    publicExposed: true,
    limits,
    reason,
  };
}

function unsupportedPolicy(category: string, reason: string, publicExposed = true): DictionaryPolicy {
  return {
    ...protectedPolicy(category, reason),
    classification: "X",
    publicExposed,
  };
}

function extensiblePolicy(category: string, reason: string): DictionaryPolicy {
  return {
    category,
    classification: "E",
    authority: "postgres",
    protected: false,
    allowCreate: true,
    allowLabelEdit: true,
    allowDescriptionEdit: true,
    allowReorder: true,
    allowDeactivate: true,
    allowReactivate: true,
    keyImmutable: true,
    participatesInHistoricalRecords: true,
    inactiveValuesRemainReadable: true,
    publicExposed: true,
    limits,
    reason,
  };
}

export const dictionaryPolicies = {
  sessionModes: protectedPolicy("sessionModes", "Mode changes application protocol and exercise-data semantics."),
  sessionStatuses: protectedPolicy("sessionStatuses", "Session lifecycle states are enforced by application transitions."),
  eventTypes: extensiblePolicy("eventTypes", "Session event types are operational labels validated on create and update against the active PostgreSQL catalog."),
  channels: unsupportedPolicy("channels", "Stored labels and enquiry validation are not yet governed end-to-end."),
  enquiryTypes: unsupportedPolicy("enquiryTypes", "Stored labels and enquiry validation are not yet governed end-to-end."),
  enquiryUrgencies: protectedPolicy("enquiryUrgencies", "Urgency values drive operational priority semantics."),
  enquiryStatuses: protectedPolicy("enquiryStatuses", "Enquiry lifecycle values are code-owned."),
  verificationStatuses: protectedPolicy("verificationStatuses", "Verification states participate in family and matching integrity."),
  personTypes: protectedPolicy("personTypes", "Person classifications participate in imports and reporting."),
  genders: unsupportedPolicy("genders", "The current persistence contract stores an unconstrained historical label."),
  nationalities: unsupportedPolicy("nationalities", "The current persistence contract stores an unconstrained historical label."),
  relationships: protectedPolicy("relationships", "Relationship values participate in import, verification, and matching semantics."),
  passengerSources: protectedPolicy("passengerSources", "Passenger source values participate in source-integrity rules and imports."),
  conditionStatuses: protectedPolicy("conditionStatuses", "Condition is a sensitive operational decision vocabulary."),
  holdTypes: protectedPolicy("holdTypes", "Hold values participate in release safety checks."),
  matchingStatuses: protectedPolicy("matchingStatuses", "Matching lifecycle values are protocol semantics."),
  releaseDestinations: unsupportedPolicy("releaseDestinations", "Release records currently store optional plain labels without catalog validation."),
  transportModes: unsupportedPolicy("transportModes", "Release records currently store optional plain labels without catalog validation."),
  requestCategories: extensiblePolicy("requestCategories", "Request categories are operational labels with a bounded create path and historical string persistence."),
  requestPriorities: protectedPolicy("requestPriorities", "Request priority is constrained in PostgreSQL and drives ordering."),
  approvalStatuses: protectedPolicy("approvalStatuses", "Approval values encode workflow semantics."),
  requestStatuses: protectedPolicy("requestStatuses", "Request lifecycle values are constrained in PostgreSQL."),
  assignmentStatuses: protectedPolicy("assignmentStatuses", "Assignment lifecycle values are constrained in PostgreSQL."),
  assignmentPriorities: protectedPolicy("assignmentPriorities", "Assignment priority is a protected operational ordering."),
  assignmentFunctions: unsupportedPolicy("assignmentFunctions", "Assignment functions are stored as historical plain labels without complete command validation."),
  exerciseInjectStatuses: protectedPolicy("exerciseInjectStatuses", "Inject lifecycle values are constrained in PostgreSQL."),
  observationAreas: protectedPolicy("observationAreas", "Observation areas are constrained evidence semantics."),
  observationSeverities: protectedPolicy("observationSeverities", "Observation severity is constrained evidence semantics."),
  communicationLanguages: unsupportedPolicy("communicationLanguages", "Language values are stored in multiple plain-string representations."),
} satisfies Record<keyof typeof dictionaries, DictionaryPolicy>;

export const profileDictionaryPolicy = unsupportedPolicy(
  "profile",
  "The application profile is explicitly code-owned; retained database rows are a non-authoritative legacy mirror.",
  false,
);

const unknownPolicy = (category: string) => unsupportedPolicy(
  category,
  "Unknown legacy category: preserved for inspection but not mutable or publicly exposed.",
  false,
);

export function dictionaryPolicy(category: string): DictionaryPolicy {
  if (category === "profile") return profileDictionaryPolicy;
  return (dictionaryPolicies as Record<string, DictionaryPolicy>)[category] ?? unknownPolicy(category);
}

export function normalizeDictionaryKey(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

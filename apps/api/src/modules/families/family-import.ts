import { dictionaries } from "@zpp/shared";
import { normalizeRow } from "../../exporters.js";

type Row = Record<string, any>;

function cell(row: Row, ...keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return undefined;
}

export function parseFamilyImportRow(rawRow: Row, sessionId: string) {
  const row = normalizeRow(rawRow) as Row;
  const firstName = cell(row, "firstName", "first_name");
  const lastName = cell(row, "lastName", "last_name");
  if (!firstName) throw new Error("firstName is required");
  if (!lastName) throw new Error("lastName is required");
  const claimedRelationship = cell(row, "claimedRelationship", "claimed_relationship");
  if (claimedRelationship && !dictionaries.relationships.includes(claimedRelationship as (typeof dictionaries.relationships)[number])) {
    throw new Error("claimedRelationship is invalid");
  }
  const email = cell(row, "email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("email is invalid");
  return {
    sessionId,
    source: "IMPORT" as const,
    caseId: cell(row, "caseId", "case_id"),
    firstName,
    lastName,
    phone: cell(row, "phone"),
    email,
    preferredContactChannel: cell(row, "preferredContactChannel", "preferred_contact_channel"),
    preferredLanguage: cell(row, "preferredLanguage", "preferred_language"),
    location: cell(row, "location"),
    claimedRelationship,
    passengerFirstName: cell(row, "passengerFirstName", "passenger_first_name"),
    passengerLastName: cell(row, "passengerLastName", "passenger_last_name"),
    passengerFlight: cell(row, "passengerFlight", "passenger_flight"),
    immediateNeeds: cell(row, "immediateNeeds", "immediate_needs"),
    questionsAsked: cell(row, "questionsAsked", "questions_asked"),
    commitmentsMade: cell(row, "commitmentsMade", "commitments_made"),
    nextContactDue: cell(row, "nextContactDue", "next_contact_due"),
    assignedOfficer: cell(row, "assignedOfficer", "assigned_officer"),
    notes: cell(row, "notes")
  };
}

export function validateFamilyImportRows(rows: Row[], sessionId: string) {
  const errors: Array<{ row: number; error: string }> = [];
  const validRows: Row[] = [];
  const previewRows: Row[] = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    try {
      validRows.push(parseFamilyImportRow(row, sessionId));
      if (previewRows.length < 10) previewRows.push({ row: rowNumber, status: "valid", values: normalizeRow(row) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid row";
      errors.push({ row: rowNumber, error: message });
      if (previewRows.length < 10) previewRows.push({ row: rowNumber, status: "invalid", values: normalizeRow(row), error: message });
    }
  });
  return { validRows, errors, previewRows };
}

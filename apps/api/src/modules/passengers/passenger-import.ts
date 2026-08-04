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

export function parsePassengerManifestRow(rawRow: Row, sessionId: string) {
  const row = normalizeRow(rawRow) as Row;
  const firstName = cell(row, "firstName", "first_name");
  const lastName = cell(row, "lastName", "last_name");
  if (!firstName) throw new Error("firstName is required");
  if (!lastName) throw new Error("lastName is required");
  const personType = cell(row, "personType", "person_type") ?? "Passenger";
  if (!dictionaries.personTypes.includes(personType as (typeof dictionaries.personTypes)[number])) throw new Error("personType is invalid");
  const ageValue = cell(row, "age");
  let age: number | undefined;
  if (ageValue !== undefined) {
    const parsedAge = Number(ageValue);
    if (!Number.isInteger(parsedAge) || parsedAge < 0 || parsedAge > 130) throw new Error("age must be a whole number between 0 and 130");
    age = parsedAge;
  }
  const dateOfBirth = cell(row, "dateOfBirth", "date_of_birth");
  if (dateOfBirth && age !== undefined) throw new Error("age must be empty when dateOfBirth is provided");
  if (dateOfBirth && Number.isNaN(new Date(dateOfBirth).getTime())) throw new Error("dateOfBirth must be a valid date");
  const source = cell(row, "source") ?? "Manifest";
  if (!dictionaries.passengerSources.includes(source as (typeof dictionaries.passengerSources)[number])) throw new Error("source is invalid");
  return {
    sessionId,
    caseId: cell(row, "caseId", "case_id"),
    personType,
    firstName,
    lastName,
    dateOfBirth,
    age,
    gender: cell(row, "gender"),
    nationality: cell(row, "nationality"),
    flightNumber: cell(row, "flightNumber", "flight_number"),
    route: cell(row, "route"),
    seat: cell(row, "seat"),
    pnr: cell(row, "pnr"),
    ticketNumber: cell(row, "ticketNumber", "ticket_number"),
    manifestVersion: cell(row, "manifestVersion", "manifest_version"),
    source,
    sourceExternalId: cell(row, "sourceExternalId", "source_external_id", "externalId", "external_id"),
    travellingCompanions: cell(row, "travellingCompanions", "travelling_companions"),
    notes: cell(row, "notes")
  };
}

export function validatePassengerManifestRows(rows: Row[], sessionId: string) {
  const errors: Array<{ row: number; error: string }> = [];
  const validRows: Row[] = [];
  const previewRows: Row[] = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    try {
      validRows.push(parsePassengerManifestRow(row, sessionId));
      if (previewRows.length < 10) previewRows.push({ row: rowNumber, status: "valid", values: normalizeRow(row) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid row";
      errors.push({ row: rowNumber, error: message });
      if (previewRows.length < 10) previewRows.push({ row: rowNumber, status: "invalid", values: normalizeRow(row), error: message });
    }
  });
  return { validRows, errors, previewRows };
}

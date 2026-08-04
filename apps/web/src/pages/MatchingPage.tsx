import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  Filter,
  GripVertical,
  Link2,
  PauseCircle,
  Search,
  ShieldAlert,
  Shuffle,
  UserRound,
  UsersRound,
  XCircle
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { isSessionWriteContextCurrent } from "../lib/session-safety";
import { DialogSurface } from "../components/DialogSurface";
import type { AnyRecord } from "../lib/types";
import { AlertBox, Badge, Button, Card, EmptyState, ErrorSummary, Field, Input, Loading, Select, StatusBadge, Textarea } from "../components/ui";

const emptyMatchForm = { status: "Potential match", holdCheck: "No hold", matchScore: "", matchScoreSource: "none" };
const familyPoolLimit = 80;
const passengerPageSize = 50;
const hoverPreviewDelayMs = 800;
const hoverPreviewWidth = 320;
const hoverPreviewHeight = 230;
const dragMime = "application/x-zpp-matching";
const finalStatuses = new Set(["Verified match", "Reunited", "Released"]);
const closedStatuses = new Set(["Verified match", "Reunited", "Released", "Rejected"]);
const movableStatuses = new Set(["Suggested", "Potential match"]);

type DragPayload = { type: "family"; familyId: string } | { type: "match"; matchId: string };
type EntityType = "pax" | "fam" | "tec" | "mat";
type EntityTarget = { type: EntityType; id?: string | null };
type HoverPreview = EntityTarget & { x: number; y: number };
type EntityField = { label: string; value: ReactNode; multiline?: boolean };
type EntityRelation = { label: string; target: EntityTarget; text: string };
type ResolvedEntity = {
  typeLabel: string;
  title: string;
  subtitle?: string;
  status?: ReactNode;
  score?: ReactNode;
  fields: EntityField[];
  relations: EntityRelation[];
  missing?: boolean;
};
type DecisionState = {
  row: AnyRecord;
  actionName: "verify" | "hold" | "clear-hold" | "reject";
  decisionNotes: string;
  holdCheck: string;
  error: string;
};

function optionalValue(value: unknown) {
  return value === "" || value === undefined ? null : value;
}

function scoreValue(value: unknown) {
  if (value === "" || value === undefined || value === null) return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function scoreLabel(value: unknown) {
  const score = scoreValue(value);
  if (score === null) return "No score";
  return `${Math.round(score * 100)}%`;
}

function scoreProvenanceLabel(record: AnyRecord) {
  if (scoreValue(record.matchScore) === null) return "No score";
  const source = record.verificationChecklist?.matchScoreSource;
  if (source === "system") return "System-calculated score";
  if (source === "manual") return "Manually entered score";
  return "Historical recorded score";
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function normalizeMatchPayload(payload: AnyRecord) {
  const { matchScoreSource: _matchScoreSource, ...record } = payload;
  return {
    ...record,
    enquiryId: optionalValue(record.enquiryId),
    familyRecordId: optionalValue(record.familyRecordId),
    passengerRecordId: optionalValue(record.passengerRecordId),
    matchScore: scoreValue(record.matchScore)
  };
}

function hasText(value: unknown) {
  return String(value ?? "").trim().length > 0;
}

function sameText(left: unknown, right: unknown) {
  if (!hasText(left) || !hasText(right)) return false;
  return String(left).trim().toLowerCase() === String(right).trim().toLowerCase();
}

function personName(record?: AnyRecord | null) {
  if (!record) return "";
  return [record.lastName, record.firstName].filter(Boolean).join(", ") || [record.firstName, record.lastName].filter(Boolean).join(" ");
}

function personLabel(record?: AnyRecord | null) {
  if (!record) return "Not linked";
  return [record.operationalId, personName(record)].filter(Boolean).join(" | ");
}

function enquiryLabel(record?: AnyRecord | null) {
  if (!record) return "Not linked";
  return [record.operationalId, record.callerName].filter(Boolean).join(" | ");
}

function familyPassengerLabel(record?: AnyRecord | null) {
  return familyPassengerName(record);
}

function familyPassengerName(record?: AnyRecord | null) {
  if (!record) return "No passenger claim";
  return [record.passengerLastName, record.passengerFirstName].filter(Boolean).join(", ") || "No passenger claim";
}

function isFinalStatus(row?: AnyRecord | null) {
  return finalStatuses.has(String(row?.status ?? ""));
}

function isMovableMatch(row?: AnyRecord | null) {
  return movableStatuses.has(String(row?.status ?? ""));
}

function canDecide(row?: AnyRecord | null) {
  return Boolean(row && !closedStatuses.has(String(row.status ?? "")));
}

function isVisibleOnBoard(row: AnyRecord) {
  return String(row.status ?? "") !== "Rejected";
}

function searchableText(values: unknown[]) {
  return values.filter(Boolean).join(" ").toLowerCase();
}

function displayValue(value: unknown, fallback = "Not recorded") {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function compactJoin(values: unknown[], separator = " | ") {
  return values.filter((value) => value !== undefined && value !== null && value !== "").join(separator);
}

function isHoldLike(value: unknown) {
  return String(value ?? "").toLowerCase().includes("hold");
}

function compactMatchStatus(value: unknown) {
  const text = String(value ?? "").trim();
  const lower = text.toLowerCase();
  if (!text || lower.includes("hold")) return "";
  if (lower === "verified match") return "Verified";
  if (lower === "potential match") return "Potential";
  return text;
}

function matchesRouteFocus(row: AnyRecord, focus: string) {
  const normalized = focus.trim().toLowerCase();
  if (!normalized) return false;
  return ["operationalId", "id", "caseId"].some((key) => String(row[key] ?? "").toLowerCase() === normalized);
}

function makeField(label: string, value: unknown, multiline = false): EntityField | null {
  if (value === undefined || value === null || value === "") return null;
  return { label, value: displayValue(value), multiline };
}

function uniqueRelations(relations: EntityRelation[]) {
  const seen = new Set<string>();
  return relations.filter((relation) => {
    if (!relation.target.id) return false;
    const key = `${relation.target.type}:${relation.target.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function computeAlignment(family?: AnyRecord | null, passenger?: AnyRecord | null, enquiry?: AnyRecord | null) {
  const checks = [
    { label: "case ID", left: family?.caseId ?? enquiry?.caseId, right: passenger?.caseId },
    { label: "passenger last name", left: family?.passengerLastName ?? enquiry?.passengerLastName, right: passenger?.lastName },
    { label: "passenger first name", left: family?.passengerFirstName ?? enquiry?.passengerFirstName, right: passenger?.firstName },
    { label: "flight", left: family?.passengerFlight ?? enquiry?.passengerFlight, right: passenger?.flightNumber },
    { label: "route", left: enquiry?.passengerRoute, right: passenger?.route }
  ];
  const available = checks.filter((check) => hasText(check.left) && hasText(check.right));
  const matched = available.filter((check) => sameText(check.left, check.right));
  const score = available.length ? matched.length / available.length : null;
  const signals = matched.map((check) => check.label);
  const basis = signals.length
    ? `Board assignment: ${signals.join(", ")} align. Requires documented ZPP verification.`
    : "Board assignment created for manual review. Document the verification basis before approval.";
  return { score: score === null ? null : Number(score.toFixed(2)), basis, signals };
}

function readDragPayload(event: DragEvent<HTMLElement>): DragPayload | null {
  try {
    const raw = event.dataTransfer.getData(dragMime);
    if (!raw) return null;
    const payload = JSON.parse(raw) as DragPayload;
    if (payload?.type === "family" && payload.familyId) return payload;
    if (payload?.type === "match" && payload.matchId) return payload;
  } catch {
    return null;
  }
  return null;
}

function decisionTitle(actionName: DecisionState["actionName"]) {
  const labels = {
    verify: "Verify Match",
    hold: "Place Hold",
    "clear-hold": "Clear Hold",
    reject: "Reject Match"
  };
  return labels[actionName];
}

function decisionActionLabel(actionName: DecisionState["actionName"]) {
  const labels = {
    verify: "Verify match",
    hold: "Place hold",
    "clear-hold": "Clear hold",
    reject: "Reject match"
  };
  return labels[actionName];
}

export function MatchingPage() {
  const { activeSession, activeSessionWritable, dictionaries, can, reload, verifyActiveSessionWrite } = useApp();
  const [searchParams] = useSearchParams();
  const routeMatchFocus = searchParams.get("match") ?? searchParams.get("focus") ?? "";
  const [rows, setRows] = useState<AnyRecord[]>([]);
  const [enquiries, setEnquiries] = useState<AnyRecord[]>([]);
  const [families, setFamilies] = useState<AnyRecord[]>([]);
  const [passengers, setPassengers] = useState<AnyRecord[]>([]);
  const [suggestions, setSuggestions] = useState<AnyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [boardError, setBoardError] = useState("");
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [poolOpen, setPoolOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [form, setForm] = useState<AnyRecord>(emptyMatchForm);
  const [formBaseline, setFormBaseline] = useState("");
  const [decisionBaseline, setDecisionBaseline] = useState("");
  const [passengerSearch, setPassengerSearch] = useState("");
  const [passengerFilter, setPassengerFilter] = useState("all");
  const [passengerPage, setPassengerPage] = useState(0);
  const [activePassengerId, setActivePassengerId] = useState("");
  const [familySearch, setFamilySearch] = useState("");
  const [poolFilter, setPoolFilter] = useState("all");
  const [targetPassengerId, setTargetPassengerId] = useState("");
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [dropPassengerId, setDropPassengerId] = useState("");
  const [selectedMatchId, setSelectedMatchId] = useState("");
  const [selectedFamilyId, setSelectedFamilyId] = useState("");
  const [inspectorTarget, setInspectorTarget] = useState<EntityTarget | null>(null);
  const [hoverPreview, setHoverPreview] = useState<HoverPreview | null>(null);
  const [decision, setDecision] = useState<DecisionState | null>(null);
  const hoverPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const routeMatchHandledRef = useRef("");
  const hoverPreviewAllowed = !contextOpen && !poolOpen && !drawerOpen && !decision;
  const canMutate = (permission: string) => activeSessionWritable && can(permission);

  const enquiryById = useMemo(() => new Map(enquiries.map((item) => [item.id, item])), [enquiries]);
  const familyById = useMemo(() => new Map(families.map((item) => [item.id, item])), [families]);
  const passengerById = useMemo(() => new Map(passengers.map((item) => [item.id, item])), [passengers]);

  const familyUsage = useMemo(() => {
    const usage = new Map<string, { rows: AnyRecord[]; activeRows: AnyRecord[]; passengerIds: Set<string>; held: number; verified: number }>();
    for (const row of rows) {
      if (!row.familyRecordId) continue;
      const current = usage.get(row.familyRecordId) ?? { rows: [], activeRows: [], passengerIds: new Set<string>(), held: 0, verified: 0 };
      current.rows.push(row);
      if (String(row.status) !== "Rejected") {
        current.activeRows.push(row);
        if (row.passengerRecordId) current.passengerIds.add(row.passengerRecordId);
      }
      if (row.holdCheck && row.holdCheck !== "No hold") current.held += 1;
      if (finalStatuses.has(String(row.status))) current.verified += 1;
      usage.set(row.familyRecordId, current);
    }
    return usage;
  }, [rows]);

  const matchesByPassenger = useMemo(() => {
    const grouped = new Map<string, AnyRecord[]>();
    for (const passenger of passengers) grouped.set(passenger.id, []);
    for (const row of rows) {
      if (!isVisibleOnBoard(row)) continue;
      if (!row.passengerRecordId || !grouped.has(row.passengerRecordId)) continue;
      grouped.get(row.passengerRecordId)!.push(row);
    }
    for (const list of grouped.values()) {
      list.sort((left, right) => {
        const leftFinal = isFinalStatus(left) ? 1 : 0;
        const rightFinal = isFinalStatus(right) ? 1 : 0;
        if (leftFinal !== rightFinal) return rightFinal - leftFinal;
        return (scoreValue(right.matchScore) ?? -1) - (scoreValue(left.matchScore) ?? -1);
      });
    }
    return grouped;
  }, [passengers, rows]);

  const unassignedRows = useMemo(
    () => rows.filter((row) => isVisibleOnBoard(row) && (!row.passengerRecordId || !passengerById.has(row.passengerRecordId))),
    [rows, passengerById]
  );
  const unassignedFamilies = useMemo(
    () => families.filter((family) => !(familyUsage.get(family.id)?.activeRows.length)),
    [families, familyUsage]
  );
  const unassignedPassengers = useMemo(
    () => passengers.filter((passenger) => !(matchesByPassenger.get(passenger.id)?.length)),
    [matchesByPassenger, passengers]
  );

  const conflictFamilyCount = useMemo(
    () => Array.from(familyUsage.values()).filter((usage) => usage.passengerIds.size > 1).length,
    [familyUsage]
  );

  const filteredPassengers = useMemo(() => {
    const query = passengerSearch.trim().toLowerCase();
    return passengers.filter((passenger) => {
      const matches = matchesByPassenger.get(passenger.id) ?? [];
      const hasHold = (passenger.holdStatus && passenger.holdStatus !== "No hold") || matches.some((match) => match.holdCheck && match.holdCheck !== "No hold");
      const hasConflict = matches.some((match) => {
        const usage = match.familyRecordId ? familyUsage.get(match.familyRecordId) : undefined;
        return Boolean(usage && usage.passengerIds.size > 1);
      });
      const haystack = searchableText([
        passenger.operationalId,
        passenger.firstName,
        passenger.lastName,
        passenger.caseId,
        passenger.flightNumber,
        passenger.route,
        passenger.seat,
        passenger.pnr,
        passenger.conditionStatus,
        passenger.holdStatus
      ]);
      const matchesSearch = !query || haystack.includes(query);
      const matchesFilter =
        passengerFilter === "all" ||
        (passengerFilter === "with-matches" && matches.length > 0) ||
        (passengerFilter === "unmatched" && matches.length === 0) ||
        (passengerFilter === "holds" && hasHold) ||
        (passengerFilter === "conflicts" && hasConflict);
      return matchesSearch && matchesFilter;
    });
  }, [familyUsage, matchesByPassenger, passengerFilter, passengerSearch, passengers]);

  const passengerPageCount = Math.max(1, Math.ceil(filteredPassengers.length / passengerPageSize));
  const activePassengerPage = Math.min(passengerPage, passengerPageCount - 1);
  const visiblePassengers = useMemo(
    () => filteredPassengers.slice(activePassengerPage * passengerPageSize, (activePassengerPage + 1) * passengerPageSize),
    [activePassengerPage, filteredPassengers]
  );
  const passengerRangeStart = filteredPassengers.length ? activePassengerPage * passengerPageSize + 1 : 0;
  const passengerRangeEnd = Math.min(filteredPassengers.length, (activePassengerPage + 1) * passengerPageSize);

  const selectedMatch = useMemo(() => rows.find((row) => row.id === selectedMatchId) ?? null, [rows, selectedMatchId]);
  const selectedFamily = useMemo(() => families.find((family) => family.id === selectedFamilyId) ?? null, [families, selectedFamilyId]);
  const activePassenger = activePassengerId ? passengerById.get(activePassengerId) ?? null : visiblePassengers[0] ?? null;
  const activePassengerMatches = activePassenger ? matchesByPassenger.get(activePassenger.id) ?? [] : [];
  const activePassengerConflicts = activePassengerMatches.filter((match) => {
    const usage = match.familyRecordId ? familyUsage.get(match.familyRecordId) : undefined;
    return Boolean(usage && usage.passengerIds.size > 1);
  }).length;
  const filteredFamilies = useMemo(() => {
    const query = familySearch.trim().toLowerCase();
    return families.filter((family) => {
      const usage = familyUsage.get(family.id);
      const haystack = [
        family.operationalId,
        family.firstName,
        family.lastName,
        family.caseId,
        family.location,
        family.claimedRelationship,
        family.passengerFirstName,
        family.passengerLastName,
        family.passengerFlight,
        family.verificationStatus
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const matchesSearch = !query || haystack.includes(query);
      const matchesFilter =
        poolFilter === "all" ||
        (poolFilter === "available" && !usage?.activeRows.length) ||
        (poolFilter === "in-review" && Boolean(usage?.activeRows.length)) ||
        (poolFilter === "conflicts" && Boolean(usage && usage.passengerIds.size > 1)) ||
        (poolFilter === "verified" && family.verificationStatus === "Verified") ||
        (poolFilter === "unverified" && family.verificationStatus !== "Verified");
      return matchesSearch && matchesFilter;
    });
  }, [families, familySearch, familyUsage, poolFilter]);

  const visibleFamilies = filteredFamilies.slice(0, familyPoolLimit);
  const visibleUnassignedFamilies = filteredFamilies.filter((family) => unassignedFamilies.some((item) => item.id === family.id)).slice(0, 40);

  const holdOptions = useMemo(
    () => (dictionaries.holdTypes ?? []).map((item) => item.label).filter((label) => label && label !== "No hold"),
    [dictionaries.holdTypes]
  );

  async function load() {
    if (!activeSession) {
      setRows([]);
      setEnquiries([]);
      setFamilies([]);
      setPassengers([]);
      setSuggestions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [matchList, enquiryList, familyList, passengerList, suggestionList] = await Promise.all([
        api.listAll("matching-records", { sessionId: activeSession.id }),
        api.listAll("enquiries", { sessionId: activeSession.id }),
        api.listAll("family-records", { sessionId: activeSession.id }),
        api.listAll("passenger-records", { sessionId: activeSession.id }),
        api.suggestions(activeSession.id)
      ]);
      setRows(matchList.data);
      setEnquiries(enquiryList.data);
      setFamilies(familyList.data);
      setPassengers(passengerList.data);
      setSuggestions(suggestionList.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load matching board");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    setDrawerOpen(false);
    setPoolOpen(false);
    setContextOpen(false);
    setDecision(null);
    setForm(emptyMatchForm);
    setPassengerSearch("");
    setPassengerFilter("all");
    setPassengerPage(0);
    setActivePassengerId("");
    setBoardError("");
    setNotice("");
    setInspectorTarget(null);
    clearHoverPreviewTimer();
    setHoverPreview(null);
  }, [activeSession?.id]);

  useEffect(() => () => clearHoverPreviewTimer(), []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!hoverPreviewAllowed) hideHoverPreview();
  }, [hoverPreviewAllowed]);

  useEffect(() => {
    setPassengerPage(0);
  }, [passengerFilter, passengerSearch]);

  useEffect(() => {
    if (!visiblePassengers.length) {
      if (activePassengerId) setActivePassengerId("");
      return;
    }
    const firstPassenger = visiblePassengers[0];
    if (firstPassenger && (!activePassengerId || !visiblePassengers.some((passenger) => passenger.id === activePassengerId))) {
      setActivePassengerId(firstPassenger.id);
    }
  }, [activePassengerId, visiblePassengers]);

  useEffect(() => {
    if (activePassengerId && passengerById.has(activePassengerId)) setTargetPassengerId(activePassengerId);
  }, [activePassengerId, passengerById]);

  useEffect(() => {
    if (!targetPassengerId && passengers[0]) setTargetPassengerId(passengers[0].id);
    if (targetPassengerId && !passengerById.has(targetPassengerId) && passengers[0]) setTargetPassengerId(passengers[0].id);
  }, [passengerById, passengers, targetPassengerId]);

  useEffect(() => {
    if (selectedMatchId && !rows.some((row) => row.id === selectedMatchId)) setSelectedMatchId("");
  }, [rows, selectedMatchId]);

  useEffect(() => {
    const focus = routeMatchFocus.trim();
    if (!focus) {
      routeMatchHandledRef.current = "";
      return;
    }
    if (loading) return;
    const match = rows.find((row) => matchesRouteFocus(row, focus));
    if (!match) return;
    const key = `${match.id}:${focus}`;
    if (routeMatchHandledRef.current === key) return;
    routeMatchHandledRef.current = key;

    const passengerId = String(match.passengerRecordId ?? "");
    if (passengerId) {
      setActivePassengerId(passengerId);
      const passengerIndex = filteredPassengers.findIndex((passenger) => passenger.id === passengerId);
      if (passengerIndex >= 0) setPassengerPage(Math.floor(passengerIndex / passengerPageSize));
    }
    setSelectedMatchId(String(match.id));
    setSelectedFamilyId("");
    setInspectorTarget({ type: "mat", id: String(match.id) });
    setContextOpen(true);
  }, [filteredPassengers, loading, routeMatchFocus, rows]);

  function linkedEnquiry(row: AnyRecord) {
    return row.enquiry ?? enquiryById.get(row.enquiryId);
  }

  function linkedFamily(row: AnyRecord) {
    return row.familyRecord ?? familyById.get(row.familyRecordId);
  }

  function linkedPassenger(row: AnyRecord) {
    return row.passengerRecord ?? passengerById.get(row.passengerRecordId);
  }

  function resolveEntity(target: EntityTarget): ResolvedEntity {
    const id = target.id ?? "";
    if (!id) {
      return { typeLabel: target.type.toUpperCase(), title: "No record selected", fields: [], relations: [], missing: true };
    }

    if (target.type === "pax") {
      const passenger = passengerById.get(id);
      if (!passenger) return { typeLabel: "PAX", title: "Passenger record not found", subtitle: id, fields: [], relations: [], missing: true };
      const relatedMatches = rows.filter((row) => row.passengerRecordId === id && isVisibleOnBoard(row));
      const relatedFamilies = relatedMatches.map(linkedFamily).filter(Boolean) as AnyRecord[];
      const relatedEnquiries = enquiries.filter((enquiry) => enquiry.passengerRecordId === id);
      const relations = uniqueRelations([
        ...relatedMatches.map((row) => ({ label: "Match", target: { type: "mat" as const, id: row.id }, text: row.operationalId })),
        ...relatedFamilies.map((family) => ({ label: "Family/NOK", target: { type: "fam" as const, id: family.id }, text: personLabel(family) })),
        ...relatedEnquiries.map((enquiry) => ({ label: "TEC", target: { type: "tec" as const, id: enquiry.id }, text: enquiryLabel(enquiry) }))
      ]);
      const fields = [
        makeField("Case", passenger.caseId),
        makeField("Type", passenger.personType),
        makeField("Name", personName(passenger)),
        makeField("DOB / age", compactJoin([passenger.dateOfBirth, passenger.age])),
        makeField("Gender / nationality", compactJoin([passenger.gender, passenger.nationality])),
        makeField("Route / seat", compactJoin([passenger.route, passenger.seat])),
        makeField("PNR / ticket", compactJoin([passenger.pnr, passenger.ticketNumber])),
        makeField("Source", compactJoin([passenger.source, passenger.manifestVersion])),
        makeField("Travelling companions", passenger.travellingCompanions, true),
        makeField("Notes", passenger.notes, true)
      ].filter(Boolean) as EntityField[];
      return {
        typeLabel: "PAX",
        title: personLabel(passenger),
        subtitle: compactJoin([passenger.route, passenger.conditionStatus]) || undefined,
        status: passenger.holdStatus && passenger.holdStatus !== "No hold" ? passenger.holdStatus : passenger.conditionStatus,
        fields,
        relations
      };
    }

    if (target.type === "fam") {
      const family = familyById.get(id);
      if (!family) return { typeLabel: "FAM", title: "Family/NOK record not found", subtitle: id, fields: [], relations: [], missing: true };
      const relatedMatches = rows.filter((row) => row.familyRecordId === id && isVisibleOnBoard(row));
      const relatedPassengers = relatedMatches.map(linkedPassenger).filter(Boolean) as AnyRecord[];
      const claimCandidates = passengers.filter(
        (passenger) =>
          sameText(passenger.lastName, family.passengerLastName) &&
          (!hasText(family.passengerFirstName) || sameText(passenger.firstName, family.passengerFirstName)) &&
          (!hasText(family.passengerFlight) || sameText(passenger.flightNumber, family.passengerFlight))
      );
      const relatedEnquiries = enquiries.filter(
        (enquiry) =>
          sameText(enquiry.passengerLastName, family.passengerLastName) &&
          (!hasText(family.passengerFirstName) || sameText(enquiry.passengerFirstName, family.passengerFirstName)) &&
          (!hasText(family.passengerFlight) || sameText(enquiry.passengerFlight, family.passengerFlight))
      );
      const relations = uniqueRelations([
        ...relatedMatches.map((row) => ({ label: "Match", target: { type: "mat" as const, id: row.id }, text: row.operationalId })),
        ...relatedPassengers.map((passenger) => ({ label: "Matched PAX", target: { type: "pax" as const, id: passenger.id }, text: personLabel(passenger) })),
        ...claimCandidates.map((passenger) => ({ label: "Claim candidate", target: { type: "pax" as const, id: passenger.id }, text: personLabel(passenger) })),
        ...relatedEnquiries.map((enquiry) => ({ label: "TEC", target: { type: "tec" as const, id: enquiry.id }, text: enquiryLabel(enquiry) }))
      ]);
      const fields = [
        makeField("Case", family.caseId),
        makeField("Claimed relationship", family.claimedRelationship),
        makeField("Passenger claim", familyPassengerLabel(family)),
        makeField("Family/NOK", personName(family)),
        makeField("Contact", compactJoin([family.phone, family.email, family.preferredContactChannel])),
        makeField("Location / language", compactJoin([family.location, family.preferredLanguage])),
        makeField("Immediate needs", family.immediateNeeds, true),
        makeField("Verification notes", family.verificationNotes, true),
        makeField("Questions asked", family.questionsAsked, true),
        makeField("Commitments made", family.commitmentsMade, true),
        makeField("Next contact / officer", compactJoin([family.nextContactDue, family.assignedOfficer])),
        makeField("Notes", family.notes, true)
      ].filter(Boolean) as EntityField[];
      return {
        typeLabel: "FAM",
        title: personLabel(family),
        subtitle: compactJoin([family.caseId, family.claimedRelationship, familyPassengerLabel(family)]) || undefined,
        status: family.verificationStatus,
        fields,
        relations
      };
    }

    if (target.type === "tec") {
      const enquiry = enquiryById.get(id);
      if (!enquiry) return { typeLabel: "TEC", title: "Enquiry record not found", subtitle: id, fields: [], relations: [], missing: true };
      const linkedPax = enquiry.passengerRecordId ? passengerById.get(enquiry.passengerRecordId) : undefined;
      const relatedMatches = rows.filter((row) => row.enquiryId === id && isVisibleOnBoard(row));
      const relatedFamilies = families.filter(
        (family) =>
          sameText(family.passengerLastName, enquiry.passengerLastName) &&
          (!hasText(enquiry.passengerFirstName) || sameText(family.passengerFirstName, enquiry.passengerFirstName)) &&
          (!hasText(enquiry.passengerFlight) || sameText(family.passengerFlight, enquiry.passengerFlight))
      );
      const relations = uniqueRelations([
        linkedPax ? { label: "Linked PAX", target: { type: "pax" as const, id: linkedPax.id }, text: personLabel(linkedPax) } : null,
        ...relatedMatches.map((row) => ({ label: "Match", target: { type: "mat" as const, id: row.id }, text: row.operationalId })),
        ...relatedFamilies.map((family) => ({ label: "Family/NOK", target: { type: "fam" as const, id: family.id }, text: personLabel(family) }))
      ].filter(Boolean) as EntityRelation[]);
      const fields = [
        makeField("Case", enquiry.caseId),
        makeField("Caller", enquiry.callerName),
        makeField("Contact", compactJoin([enquiry.callerPhone, enquiry.callerEmail, enquiry.contactChannel])),
        makeField("Location / language", compactJoin([enquiry.callerLocation, enquiry.preferredLanguage])),
        makeField("Claimed relationship", enquiry.claimedRelationship),
        makeField("Passenger claim", compactJoin([[enquiry.passengerLastName, enquiry.passengerFirstName].filter(Boolean).join(", "), enquiry.passengerFlight, enquiry.passengerRoute])),
        makeField("Type / urgency", compactJoin([enquiry.enquiryType, enquiry.urgency])),
        makeField("Last known contact", enquiry.lastKnownContact, true),
        makeField("Notes", enquiry.notes, true)
      ].filter(Boolean) as EntityField[];
      return {
        typeLabel: "TEC",
        title: enquiryLabel(enquiry),
        subtitle: compactJoin([enquiry.status, enquiry.urgency, enquiry.contactChannel]) || undefined,
        status: enquiry.status,
        fields,
        relations
      };
    }

    const match = rows.find((row) => row.id === id);
    if (!match) return { typeLabel: "MAT", title: "Match record not found", subtitle: id, fields: [], relations: [], missing: true };
    const family = linkedFamily(match);
    const passenger = linkedPassenger(match);
    const enquiry = linkedEnquiry(match);
    const relations = uniqueRelations([
      family ? { label: "Family/NOK", target: { type: "fam" as const, id: family.id }, text: personLabel(family) } : null,
      passenger ? { label: "PAX", target: { type: "pax" as const, id: passenger.id }, text: personLabel(passenger) } : null,
      enquiry ? { label: "TEC", target: { type: "tec" as const, id: enquiry.id }, text: enquiryLabel(enquiry) } : null
    ].filter(Boolean) as EntityRelation[]);
    const fields = [
      makeField("Family/NOK", family ? personLabel(family) : null),
      makeField("PAX", passenger ? personLabel(passenger) : null),
      makeField("TEC", enquiry ? enquiryLabel(enquiry) : null),
      makeField("Case", match.caseId),
      makeField("Status", match.status),
      makeField("Hold check", match.holdCheck),
      makeField("Coordinator override", match.coordinatorOverride),
      makeField("Approved at", match.approvedAt),
      makeField("Score provenance", scoreProvenanceLabel(match)),
      makeField("Match basis", match.matchBasis, true),
      makeField("Decision notes", match.decisionNotes, true),
      makeField("Override reason", match.overrideReason, true)
    ].filter(Boolean) as EntityField[];
    return {
      typeLabel: "MAT",
      title: match.operationalId,
      subtitle: compactJoin([match.caseId, match.status]) || undefined,
      status: match.status,
      score: scoreValue(match.matchScore) === null ? "No score" : scoreLabel(match.matchScore),
      fields,
      relations
    };
  }

  function inferEnquiry(family?: AnyRecord | null, passenger?: AnyRecord | null) {
    if (!passenger) return undefined;
    return (
      enquiries.find((enquiry) => enquiry.passengerRecordId === passenger.id) ??
      enquiries.find((enquiry) => sameText(enquiry.caseId, passenger.caseId) && (sameText(enquiry.caseId, family?.caseId) || !family?.caseId)) ??
      enquiries.find(
        (enquiry) =>
          sameText(enquiry.passengerLastName, passenger.lastName) &&
          (!hasText(enquiry.passengerFirstName) || sameText(enquiry.passengerFirstName, passenger.firstName)) &&
          (!hasText(enquiry.passengerFlight) || sameText(enquiry.passengerFlight, passenger.flightNumber))
      ) ??
      enquiries.find(
        (enquiry) =>
          sameText(enquiry.passengerLastName, family?.passengerLastName) &&
          (!hasText(enquiry.passengerFlight) || sameText(enquiry.passengerFlight, family?.passengerFlight))
      )
    );
  }

  function addAmbiguityWarning(alignment: ReturnType<typeof computeAlignment>, family?: AnyRecord | null, passenger?: AnyRecord | null, enquiry?: AnyRecord | null) {
    if (!passenger) return alignment;
    const claimedLastName = family?.passengerLastName ?? enquiry?.passengerLastName;
    const claimedFirstName = family?.passengerFirstName ?? enquiry?.passengerFirstName;
    const claimedFlight = family?.passengerFlight ?? enquiry?.passengerFlight;
    const firstNameMatches = sameText(passenger.firstName, claimedFirstName);
    const sameLastFlight =
      hasText(claimedLastName) && hasText(claimedFlight)
        ? passengers.filter((item) => sameText(item.lastName, claimedLastName) && sameText(item.flightNumber, claimedFlight))
        : [];
    const surnameOnly = sameText(passenger.lastName, claimedLastName) && !firstNameMatches && !hasText(claimedFlight);
    if ((sameLastFlight.length > 1 && !firstNameMatches) || surnameOnly) {
      const detail = sameLastFlight.length > 1 ? `${sameLastFlight.length} passengers share this surname and flight` : "surname-only evidence is ambiguous";
      return {
        score: alignment.score === null ? null : Math.min(alignment.score, 0.55),
        signals: alignment.signals,
        basis: `${alignment.basis} Ambiguity warning: ${detail}; verify first name, case ID or another identifier before approval.`
      };
    }
    return alignment;
  }

  function openEntity(target: EntityTarget) {
    if (!target.id) return;
    clearHoverPreviewTimer();
    setHoverPreview(null);
    setDrawerOpen(false);
    setPoolOpen(false);
    setInspectorTarget(target);
    setSelectedMatchId(target.type === "mat" ? target.id : "");
    setSelectedFamilyId(target.type === "fam" ? target.id : "");
    setContextOpen(true);
  }

  function openCreateMatch(draft: AnyRecord = {}) {
    if (!activeSessionWritable || !activeSession) return;
    clearHoverPreviewTimer();
    setHoverPreview(null);
    const nextForm = { ...emptyMatchForm, ...draft, sessionId: activeSession.id };
    setForm(nextForm);
    setFormBaseline(JSON.stringify(nextForm));
    setFormError("");
    setPoolOpen(false);
    setContextOpen(false);
    setInspectorTarget(null);
    setDrawerOpen(true);
  }

  function openMatchContext(row: AnyRecord) {
    openEntity({ type: "mat", id: row.id });
  }

  function openFamilyContext(family: AnyRecord) {
    openEntity({ type: "fam", id: family.id });
  }

  function openSuggestion(suggestion: AnyRecord) {
    openCreateMatch({
      enquiryId: suggestion.enquiry?.id ?? "",
      familyRecordId: suggestion.familyRecord?.id ?? "",
      passengerRecordId: suggestion.passengerRecord?.id ?? "",
      matchScore: suggestion.matchScore ?? "",
      matchScoreSource: suggestion.matchScore === undefined || suggestion.matchScore === null ? "none" : "system",
      matchBasis: suggestion.matchBasis ?? ""
    });
  }

  async function validateMatchingDraft(draft: AnyRecord) {
    if (!activeSession) return { error: "Select an open session before creating a match." };
    if (!draft.familyRecordId || !draft.passengerRecordId) {
      return { error: "Select both a Family/NOK record and a Passenger/SRC record." };
    }
    const [familyList, passengerList, enquiryList, matchList] = await Promise.all([
      api.listAll("family-records", { sessionId: activeSession.id }),
      api.listAll("passenger-records", { sessionId: activeSession.id }),
      api.listAll("enquiries", { sessionId: activeSession.id }),
      api.listAll("matching-records", { sessionId: activeSession.id })
    ]);
    const family = familyList.data.find((item) => item.id === draft.familyRecordId);
    const passenger = passengerList.data.find((item) => item.id === draft.passengerRecordId);
    const enquiry = draft.enquiryId ? enquiryList.data.find((item) => item.id === draft.enquiryId) : undefined;
    if (!family) return { error: "The selected Family/NOK record is missing, stale or belongs to another session." };
    if (!passenger) return { error: "The selected Passenger/SRC record is missing, stale or belongs to another session." };
    if (draft.enquiryId && !enquiry) return { error: "The selected TEC enquiry is missing, stale or belongs to another session." };
    if (family.sessionId !== activeSession.id || passenger.sessionId !== activeSession.id || (enquiry && enquiry.sessionId !== activeSession.id)) {
      return { error: "All matching links must belong to the active session." };
    }
    if (family.caseId && passenger.caseId && family.caseId !== passenger.caseId) {
      return { error: "The selected Family/NOK and Passenger/SRC records belong to different cases." };
    }
    const duplicate = matchList.data.find(
      (item) => item.familyRecordId === family.id && item.passengerRecordId === passenger.id && String(item.status) !== "Rejected"
    );
    if (duplicate) return { error: `${duplicate.operationalId} already links the selected Family/NOK and Passenger/SRC records.`, existing: duplicate };
    const enteredScore = String(draft.matchScore ?? "").trim();
    const parsedScore = scoreValue(enteredScore);
    if (enteredScore && (parsedScore === null || parsedScore < 0 || parsedScore > 1)) {
      return { error: "Confidence score must be empty or a number between 0 and 1." };
    }
    return { family, passenger, enquiry, caseId: family.caseId ?? passenger.caseId ?? enquiry?.caseId ?? null };
  }

  function writeDragPayload(event: DragEvent<HTMLElement>, payload: DragPayload) {
    event.dataTransfer.setData(dragMime, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = payload.type === "family" ? "copy" : "move";
    setDragging(payload);
  }

  async function savePotentialMatch() {
    if (!activeSession || !canMutate("matching:create") || !isSessionWriteContextCurrent(activeSession, form.sessionId) || !(await verifyActiveSessionWrite(form.sessionId))) {
      setFormError("The session changed or is no longer writable. This match was not created.");
      return;
    }
    const validation = await validateMatchingDraft(form);
    if (validation.error) {
      setFormError(validation.error);
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const record = await api.create("matching-records", {
        ...normalizeMatchPayload(form),
        sessionId: activeSession.id,
        caseId: validation.caseId,
        familyRecordId: validation.family?.id,
        passengerRecordId: validation.passenger?.id,
        enquiryId: validation.enquiry?.id ?? null,
        verificationChecklist: { matchScoreSource: form.matchScoreSource ?? "none" },
        status: "Potential match",
        holdCheck: "No hold"
      });
      setForm(emptyMatchForm);
      setFormBaseline("");
      setDrawerOpen(false);
      setSelectedMatchId(record.id);
      setSelectedFamilyId("");
      setInspectorTarget({ type: "mat", id: record.id });
      setContextOpen(true);
      setNotice(`Potential match ${record.operationalId} created.`);
      await Promise.all([load(), reload()]);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Unable to create potential match");
    } finally {
      setSaving(false);
    }
  }

  async function createMatchFromFamily(familyId: string, passengerId: string) {
    if (!activeSession || !canMutate("matching:create")) return;
    const family = familyById.get(familyId);
    const passenger = passengerById.get(passengerId);
    if (!family || !passenger) return;
    if (!isSessionWriteContextCurrent(activeSession, family.sessionId) || !isSessionWriteContextCurrent(activeSession, passenger.sessionId)) {
      setBoardError("The session changed or is closed. This match was not created.");
      return;
    }
    if (!(await verifyActiveSessionWrite(activeSession.id))) {
      setBoardError("The session changed or is closed. This match was not created.");
      return;
    }

    const existing = rows.find((row) => row.familyRecordId === familyId && row.passengerRecordId === passengerId && String(row.status) !== "Rejected");
    if (existing) {
      openMatchContext(existing);
      setNotice(`${existing.operationalId} already stages this family for ${passenger.operationalId}.`);
      return;
    }

    const inferredEnquiry = inferEnquiry(family, passenger);
    const validation = await validateMatchingDraft({
      familyRecordId: family.id,
      passengerRecordId: passenger.id,
      enquiryId: inferredEnquiry?.id,
      matchScore: ""
    });
    if (validation.error) {
      if (validation.existing) openMatchContext(validation.existing);
      setBoardError(validation.error);
      return;
    }
    const authoritativeFamily = validation.family ?? family;
    const authoritativePassenger = validation.passenger ?? passenger;
    const enquiry = validation.enquiry;
    const alignment = addAmbiguityWarning(
      computeAlignment(authoritativeFamily, authoritativePassenger, enquiry),
      authoritativeFamily,
      authoritativePassenger,
      enquiry
    );
    setBusyKey(`family:${familyId}:${passengerId}`);
    setBoardError("");
    setNotice("");
    try {
      const record = await api.create("matching-records", {
        sessionId: activeSession.id,
        caseId: validation.caseId,
        enquiryId: enquiry?.id ?? null,
        familyRecordId: authoritativeFamily.id,
        passengerRecordId: authoritativePassenger.id,
        status: "Potential match",
        holdCheck: "No hold",
        matchScore: alignment.score,
        verificationChecklist: { matchScoreSource: "system" },
        matchBasis: alignment.basis
      });
      setSelectedMatchId(record.id);
      setSelectedFamilyId("");
      setInspectorTarget({ type: "mat", id: record.id });
      setPoolOpen(false);
      setContextOpen(true);
      setNotice(`Potential match created for ${passenger.operationalId}.`);
      await Promise.all([load(), reload()]);
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : "Unable to create potential match");
    } finally {
      setBusyKey("");
    }
  }

  async function moveMatchToPassenger(matchId: string, passengerId: string) {
    const row = rows.find((item) => item.id === matchId);
    const passenger = passengerById.get(passengerId);
    if (!row || !passenger || !canMutate("matching:create") || !isSessionWriteContextCurrent(activeSession, row.sessionId) || !(await verifyActiveSessionWrite(row.sessionId))) return;
    if (!isMovableMatch(row)) {
      setBoardError("Only suggested and potential matches can be moved on the board.");
      return;
    }
    const family = linkedFamily(row);
    const existing = rows.find(
      (item) => item.id !== row.id && item.familyRecordId === row.familyRecordId && item.passengerRecordId === passengerId && String(item.status) !== "Rejected"
    );
    if (existing) {
      openMatchContext(existing);
      setNotice(`${existing.operationalId} already stages this family for ${passenger.operationalId}.`);
      return;
    }

    const enquiry = inferEnquiry(family, passenger);
    const alignment = addAmbiguityWarning(computeAlignment(family, passenger, enquiry), family, passenger, enquiry);
    setBusyKey(`match:${matchId}:${passengerId}`);
    setBoardError("");
    setNotice("");
    try {
      await api.update("matching-records", row.id, {
        caseId: family?.caseId ?? passenger.caseId ?? enquiry?.caseId ?? row.caseId ?? null,
        enquiryId: enquiry?.id ?? row.enquiryId ?? null,
        passengerRecordId: passenger.id,
        matchScore: alignment.score,
        matchBasis: alignment.basis
      });
      setSelectedMatchId(row.id);
      setSelectedFamilyId("");
      setInspectorTarget({ type: "mat", id: row.id });
      setContextOpen(true);
      setNotice(`${row.operationalId} moved to ${passenger.operationalId}.`);
      await Promise.all([load(), reload()]);
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : "Unable to move potential match");
    } finally {
      setBusyKey("");
    }
  }

  async function handlePassengerDrop(event: DragEvent<HTMLElement>, passengerId: string) {
    event.preventDefault();
    setDropPassengerId("");
    const payload = readDragPayload(event);
    if (!payload) return;
    if (payload.type === "family") await createMatchFromFamily(payload.familyId, passengerId);
    if (payload.type === "match") await moveMatchToPassenger(payload.matchId, passengerId);
  }

  async function runDecision(current: DecisionState) {
    if (!canMutate(`matching:${current.actionName === "clear-hold" ? "clearHold" : current.actionName}`) || !isSessionWriteContextCurrent(activeSession, current.row.sessionId) || !(await verifyActiveSessionWrite(current.row.sessionId))) {
      setDecision({ ...current, error: "The session changed or is closed. This decision was not submitted." });
      return;
    }
    const decisionNotes = current.decisionNotes.trim();
    if (decisionNotes.length < 3) {
      setDecision({ ...current, error: "Decision basis is required." });
      return;
    }
    if (current.actionName === "hold" && !current.holdCheck) {
      setDecision({ ...current, error: "Hold type is required." });
      return;
    }

    setBusyKey(`${current.actionName}:${current.row.id}`);
    try {
      await api.action("matching-records", current.row.id, current.actionName, {
        decisionNotes,
        matchBasis: current.actionName === "verify" ? current.row.matchBasis : undefined,
        holdCheck: current.actionName === "hold" ? current.holdCheck : undefined
      });
      setDecisionBaseline("");
      setDecision(null);
      setSelectedMatchId(current.row.id);
      setSelectedFamilyId("");
      setInspectorTarget({ type: "mat", id: current.row.id });
      setNotice(`${current.row.operationalId} updated.`);
      await Promise.all([load(), reload()]);
    } catch (err) {
      setDecision({ ...current, error: err instanceof Error ? err.message : "Unable to submit decision" });
    } finally {
      setBusyKey("");
    }
  }

  function openDecision(row: AnyRecord, actionName: DecisionState["actionName"]) {
    if (!activeSessionWritable) return;
    setSelectedMatchId(row.id);
    setSelectedFamilyId("");
    setInspectorTarget({ type: "mat", id: row.id });
    setPoolOpen(false);
    setContextOpen(true);
    const nextDecision = {
      row,
      actionName,
      decisionNotes: "",
      holdCheck: holdOptions[0] ?? "Identity verification hold",
      error: ""
    };
    setDecision(nextDecision);
    setDecisionBaseline(JSON.stringify(nextDecision));
  }

  function clearHoverPreviewTimer() {
    if (!hoverPreviewTimerRef.current) return;
    clearTimeout(hoverPreviewTimerRef.current);
    hoverPreviewTimerRef.current = null;
  }

  function scheduleHoverPreview(target: EntityTarget, event: MouseEvent<HTMLElement>) {
    if (!target.id || !hoverPreviewAllowed) return;
    const alreadyVisible = hoverPreview?.type === target.type && hoverPreview.id === target.id;
    if (alreadyVisible) return;
    const x = event.clientX;
    const y = event.clientY;
    clearHoverPreviewTimer();
    hoverPreviewTimerRef.current = setTimeout(() => {
      setHoverPreview({ ...target, id: target.id, x, y });
      hoverPreviewTimerRef.current = null;
    }, hoverPreviewDelayMs);
  }

  function hideHoverPreview() {
    clearHoverPreviewTimer();
    setHoverPreview(null);
  }

  function EntityRef({ target, children, className = "", preview = true }: { target: EntityTarget; children: ReactNode; className?: string; preview?: boolean }) {
    if (!target.id) return <span className={className}>{children}</span>;
    const hoverHandlers = preview
      ? {
          onMouseEnter: (event: MouseEvent<HTMLElement>) => scheduleHoverPreview(target, event),
          onMouseMove: (event: MouseEvent<HTMLElement>) => scheduleHoverPreview(target, event),
          onMouseLeave: hideHoverPreview
        }
      : {};
    return (
      <button
        type="button"
        className={[
          "focus-ring min-w-0 max-w-full truncate rounded-sm text-left font-bold text-current underline-offset-2 hover:text-blue-800 hover:underline",
          className
        ].join(" ")}
        {...hoverHandlers}
        onClick={(event) => {
          event.stopPropagation();
          hideHoverPreview();
          openEntity(target);
        }}
      >
        {children}
      </button>
    );
  }

  function renderEntityFields(entity: ResolvedEntity, compact = false) {
    const fields = compact ? entity.fields.slice(0, 5) : entity.fields;
    if (!fields.length) {
      return <p className="rounded-md border border-dashed border-slate-200 px-3 py-2 text-sm font-semibold text-slate-500">No details recorded.</p>;
    }
    return (
      <div className="grid gap-2">
        {fields.map((field) => (
          <div key={field.label} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{field.label}</p>
            <p className={["mt-1 text-sm font-semibold text-slate-900", field.multiline ? "whitespace-pre-wrap leading-6" : "truncate"].join(" ")}>{field.value}</p>
          </div>
        ))}
      </div>
    );
  }

  function renderEntityRelations(entity: ResolvedEntity, compact = false) {
    const relations = compact ? entity.relations.slice(0, 3) : entity.relations.slice(0, 10);
    if (!relations.length) return null;
    return (
      <div className="grid gap-2">
        <p className="text-xs font-black uppercase tracking-wide text-slate-500">Linked records</p>
        {relations.map((relation) => (
          <div key={`${relation.target.type}:${relation.target.id}`} className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-3 py-2">
            <span className="shrink-0 text-xs font-bold uppercase tracking-wide text-slate-500">{relation.label}</span>
            <EntityRef target={relation.target} className="text-sm" preview={false}>
              {relation.text}
            </EntityRef>
          </div>
        ))}
        {entity.relations.length > relations.length ? (
          <p className="text-xs font-semibold text-slate-500">+{entity.relations.length - relations.length} more linked records. Narrow by opening the source table if needed.</p>
        ) : null}
      </div>
    );
  }

  function renderEntityHeader(entity: ResolvedEntity, compact = false) {
    if (!compact) {
      return (
        <div className="grid min-w-0 gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge tone={entity.missing ? "danger" : "neutral"}>{entity.typeLabel}</Badge>
            {entity.score ? <Badge tone="neutral">{entity.score}</Badge> : null}
            {entity.status ? <StatusBadge value={String(entity.status)} /> : null}
          </div>
          <div className="min-w-0">
            <p className="break-words text-base font-black leading-6 text-slate-950">{entity.title}</p>
            {entity.subtitle ? <p className="mt-1 break-words text-sm font-semibold leading-5 text-slate-500">{entity.subtitle}</p> : null}
          </div>
        </div>
      );
    }
    return (
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone={entity.missing ? "danger" : "neutral"}>{entity.typeLabel}</Badge>
            {entity.score ? <Badge tone="neutral">{entity.score}</Badge> : null}
          </div>
          <p className={["mt-2 truncate font-black text-slate-950", compact ? "text-sm" : "text-base"].join(" ")}>{entity.title}</p>
          {entity.subtitle ? <p className="mt-1 truncate text-sm font-semibold text-slate-500">{entity.subtitle}</p> : null}
        </div>
        {entity.status ? <StatusBadge value={String(entity.status)} /> : null}
      </div>
    );
  }

  function renderHoverPreview(entity: ResolvedEntity) {
    const facts = entity.fields.slice(0, 3);
    return (
      <div className="grid gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge tone={entity.missing ? "danger" : "neutral"}>{entity.typeLabel}</Badge>
          {entity.score ? <Badge tone="neutral">{entity.score}</Badge> : null}
          {entity.status ? (
            <span className="inline-flex max-w-[160px] truncate rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-bold leading-5 text-slate-700">
              {String(entity.status)}
            </span>
          ) : null}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-black text-slate-950">{entity.title}</p>
          {entity.subtitle ? <p className="mt-0.5 truncate text-xs font-semibold text-slate-500">{entity.subtitle}</p> : null}
        </div>
        {facts.length ? (
          <div className="grid gap-1.5 border-t border-slate-100 pt-2">
            {facts.map((field) => (
              <div key={field.label} className="grid grid-cols-[86px_minmax(0,1fr)] gap-2 text-xs">
                <span className="truncate font-bold uppercase tracking-wide text-slate-400">{field.label}</span>
                <span className="truncate font-semibold text-slate-800">{field.value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderEntityInspector(entity: ResolvedEntity, target: EntityTarget) {
    const match = target.type === "mat" && target.id ? rows.find((row) => row.id === target.id) : null;
    const family = target.type === "fam" && target.id ? familyById.get(target.id) : null;
    return (
      <div className="grid gap-4">
        {renderEntityHeader(entity)}
        {renderEntityFields(entity)}
        {renderEntityRelations(entity)}
        {match ? renderDecisionButtons(match, true) : null}
        {match && can("release:read") ? (
          <Link
            to={`/release-control?match=${encodeURIComponent(match.id)}`}
            className="focus-ring inline-flex min-h-9 items-center justify-center rounded-md border border-border bg-card px-3 text-sm font-black text-[#145C63] hover:bg-muted"
          >
            Open existing or prepare release action
          </Link>
        ) : null}
        {family ? (
          <div className="grid gap-3 rounded-md border border-slate-200 bg-white p-3">
            <Field label="Target PAX">
              <>
                <Select value={targetPassengerId} onChange={(event) => setTargetPassengerId(event.target.value)}>
                  <option value="">Select PAX</option>
                  {passengers.map((passenger) => (
                    <option key={passenger.id} value={passenger.id}>
                      {passenger.operationalId} | {personName(passenger)}
                    </option>
                  ))}
                </Select>
                {targetPassengerId && passengerById.get(targetPassengerId) ? (
                  <EntityRef target={{ type: "pax", id: targetPassengerId }} className="text-xs text-slate-700" preview={false}>
                    {personLabel(passengerById.get(targetPassengerId))}
                  </EntityRef>
                ) : null}
              </>
            </Field>
            <Button
              className="w-full"
              icon={Shuffle}
              variant="primary"
              disabled={!canMutate("matching:create") || !targetPassengerId || Boolean(busyKey)}
              onClick={() => void createMatchFromFamily(family.id, targetPassengerId)}
            >
              Add to PAX folder
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  function renderDecisionButtons(row: AnyRecord, compact = false) {
    const blocked = Boolean(busyKey);
    return (
      <div className={compact ? "grid gap-2" : "flex flex-wrap gap-2"}>
        {canMutate("matching:verify") && canDecide(row) ? (
          <Button icon={CheckCircle2} size="sm" variant="success" disabled={blocked} onClick={() => openDecision(row, "verify")}>
            Verify
          </Button>
        ) : null}
        {canMutate("matching:hold") && canDecide(row) ? (
          <Button icon={ShieldAlert} size="sm" variant="warning" disabled={blocked} onClick={() => openDecision(row, "hold")}>
            Hold
          </Button>
        ) : null}
        {canMutate("matching:clearHold") && row.holdCheck && row.holdCheck !== "No hold" && !closedStatuses.has(String(row.status)) ? (
          <Button icon={PauseCircle} size="sm" variant="secondary" disabled={blocked} onClick={() => openDecision(row, "clear-hold")}>
            Clear
          </Button>
        ) : null}
        {canMutate("matching:reject") && canDecide(row) ? (
          <Button icon={XCircle} size="sm" variant="danger" disabled={blocked} onClick={() => openDecision(row, "reject")}>
            Reject
          </Button>
        ) : null}
      </div>
    );
  }

  function renderMatchCard(row: AnyRecord) {
    const family = linkedFamily(row);
    const usage = row.familyRecordId ? familyUsage.get(row.familyRecordId) : undefined;
    const conflict = Boolean(usage && usage.passengerIds.size > 1);
    const movable = canMutate("matching:create") && isMovableMatch(row);
    const selected = selectedMatchId === row.id;
    const holdText = row.holdCheck && row.holdCheck !== "No hold" ? String(row.holdCheck) : isHoldLike(row.status) ? String(row.status) : "";
    const statusLabel = compactMatchStatus(row.status);
    const statusTone = isFinalStatus(row) ? "success" : String(row.status ?? "") === "Rejected" ? "danger" : String(row.status ?? "") === "Suggested" ? "info" : "neutral";
    return (
      <article
        key={row.id}
        draggable={movable}
        onDragStart={(event) => movable && writeDragPayload(event, { type: "match", matchId: row.id })}
        onDragEnd={() => setDragging(null)}
        onClick={() => openMatchContext(row)}
        className={[
          "min-w-0 rounded-md border bg-card p-2.5 shadow-sm transition hover:border-[#145C63]/50",
          movable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
          selected ? "border-[#145C63] ring-2 ring-ring" : conflict ? "border-amber-300" : "border-border",
          dragging?.type === "match" && dragging.matchId === row.id ? "opacity-50" : ""
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              {movable ? <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-400" /> : null}
              <EntityRef target={{ type: "mat", id: row.id }} className="block text-sm font-black">
                {row.operationalId}
              </EntityRef>
            </div>
            <p className="mt-0.5 truncate text-xs font-semibold text-slate-500">
              {family ? (
                <EntityRef target={{ type: "fam", id: family.id }} className="text-xs text-slate-600">
                  {personLabel(family)}
                </EntityRef>
              ) : (
                personLabel(family)
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {holdText ? (
              <span
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-amber-300 bg-amber-50 text-amber-800"
                aria-label={holdText}
                title={holdText}
              >
                <ShieldAlert className="h-3.5 w-3.5" />
              </span>
            ) : null}
            <Badge tone={conflict ? "warning" : "neutral"}>{scoreLabel(row.matchScore)}</Badge>
          </div>
        </div>
        {statusLabel || conflict ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {statusLabel ? <Badge tone={statusTone}>{statusLabel}</Badge> : null}
            {conflict ? <Badge tone="warning">Conflict</Badge> : null}
          </div>
        ) : null}
      </article>
    );
  }

  function renderFamilyCard(family: AnyRecord) {
    const usage = familyUsage.get(family.id);
    const conflict = Boolean(usage && usage.passengerIds.size > 1);
    const activeCount = usage?.activeRows.length ?? 0;
    const selected = selectedFamilyId === family.id;
    const canCreate = canMutate("matching:create");
    const stateLabel = conflict ? "Conflict" : usage?.verified ? "Linked" : activeCount ? "Staged" : "";
    const stateTone = conflict ? "warning" : usage?.verified ? "success" : "info";
    const contextLine = compactJoin([family.caseId, family.claimedRelationship, familyPassengerName(family)]) || "No claim context";
    return (
      <article
        key={family.id}
        draggable={canCreate}
        onDragStart={(event) => canCreate && writeDragPayload(event, { type: "family", familyId: family.id })}
        onDragEnd={() => setDragging(null)}
        onClick={() => openFamilyContext(family)}
        className={[
          "w-full min-w-0 rounded-md border bg-card p-2.5 shadow-sm transition hover:border-[#145C63]/50",
          canCreate ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
          selected ? "border-[#145C63] ring-2 ring-ring" : conflict ? "border-amber-300" : "border-border",
          dragging?.type === "family" && dragging.familyId === family.id ? "opacity-50" : ""
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              {canCreate ? <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-400" /> : null}
              <EntityRef target={{ type: "fam", id: family.id }} className="block text-sm font-black">
                {personLabel(family)}
              </EntityRef>
            </div>
            <p className="mt-1 truncate text-xs font-semibold text-slate-500">{contextLine}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {usage?.held ? (
              <span
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-amber-300 bg-amber-50 text-amber-800"
                aria-label="Hold present"
                title="Hold present"
              >
                <ShieldAlert className="h-3.5 w-3.5" />
              </span>
            ) : null}
            {stateLabel ? <Badge tone={stateTone}>{stateLabel}</Badge> : null}
          </div>
        </div>
      </article>
    );
  }

  const inspectedEntity = inspectorTarget ? resolveEntity(inspectorTarget) : null;
  const hoverEntity = hoverPreview ? resolveEntity(hoverPreview) : null;
  const hoverPreviewStyle = (() => {
    if (!hoverPreview) return undefined;
    const gap = 14;
    const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
    const preferRight = hoverPreview.x + hoverPreviewWidth + gap < viewportWidth - 16;
    return {
      left: preferRight ? hoverPreview.x + gap : Math.max(16, hoverPreview.x - hoverPreviewWidth - gap),
      top: Math.min(Math.max(16, hoverPreview.y + gap), Math.max(16, viewportHeight - hoverPreviewHeight - 24))
    };
  })();

  return (
    <div className="grid gap-5">
      <AlertBox>Matching, NOK verification, reunification, release and protected disclosure require documented human authorization.</AlertBox>

      {notice ? (
        <div
          className="fixed bottom-4 right-4 z-50 flex w-[min(420px,calc(100vw-2rem))] items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-950 shadow-lg shadow-slate-950/10"
          role="status"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="min-w-0 flex-1">{notice}</p>
          <button
            type="button"
            className="focus-ring -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-emerald-900 hover:bg-emerald-100"
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      {boardError ? <AlertBox>{boardError}</AlertBox> : null}

      <Card>
        <div className="border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1 2xl:max-w-[360px] 2xl:flex-none">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input
                aria-label="Find PAX"
                className="h-9 pl-9"
                value={passengerSearch}
                placeholder="Name, PAX ID, case"
                onChange={(event) => setPassengerSearch(event.target.value)}
              />
            </div>
            <Select aria-label="PAX view" className="h-9 w-full sm:w-40" value={passengerFilter} onChange={(event) => setPassengerFilter(event.target.value)}>
              <option value="all">All PAX</option>
              <option value="with-matches">With candidates</option>
              <option value="unmatched">No candidates</option>
              <option value="holds">Holds</option>
              <option value="conflicts">Conflicts</option>
            </Select>
            <div className="flex h-9 w-full items-center justify-between gap-1 rounded-md border border-border bg-card px-1 text-sm text-foreground sm:w-auto sm:min-w-52">
              <Button
                icon={ChevronLeft}
                size="icon"
                variant="ghost"
                aria-label="Previous PAX page"
                disabled={activePassengerPage === 0}
                onClick={() => setPassengerPage((current) => Math.max(0, current - 1))}
              />
              <p className="whitespace-nowrap px-2 text-sm font-semibold text-foreground">
                {passengerRangeStart} - {passengerRangeEnd} of {filteredPassengers.length}
              </p>
              <Button
                icon={ChevronRight}
                size="icon"
                variant="ghost"
                aria-label="Next PAX page"
                disabled={activePassengerPage >= passengerPageCount - 1}
                onClick={() => setPassengerPage((current) => Math.min(passengerPageCount - 1, current + 1))}
              />
            </div>
            {conflictFamilyCount ? <Badge tone="warning">{countLabel(conflictFamilyCount, "conflict")}</Badge> : null}
            <Button icon={Filter} variant="secondary" onClick={() => setPoolOpen(true)}>
              Suggestions / Unassigned
            </Button>
            <Button
              icon={FilePlus2}
              variant="create"
              disabled={!canMutate("matching:create")}
              onClick={() => openCreateMatch(activePassenger ? { passengerRecordId: activePassenger.id } : {})}
            >
              New
            </Button>
          </div>
        </div>
        <div className="p-4">
          {loading ? (
            <Loading />
          ) : error ? (
            <EmptyState title="Unable to load matching records" detail={error} action={<Button onClick={() => void load()}>Retry</Button>} />
          ) : visiblePassengers.length && activePassenger ? (
            <div className="grid gap-4 xl:grid-cols-[280px_minmax(420px,1fr)_360px]">
              <section className="overflow-hidden rounded-md border border-border bg-muted">
                <div className="border-b border-border bg-card px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-black uppercase tracking-wide text-muted-foreground">PAX queue</p>
                  </div>
                </div>
                <div className="scrollbar-soft grid max-h-[560px] content-start gap-1.5 overflow-y-auto p-2">
                {visiblePassengers.map((passenger) => {
                  const matches = matchesByPassenger.get(passenger.id) ?? [];
                  const verified = matches.filter(isFinalStatus).length;
                  const conflicts = matches.filter((match) => {
                    const usage = match.familyRecordId ? familyUsage.get(match.familyRecordId) : undefined;
                    return Boolean(usage && usage.passengerIds.size > 1);
                  }).length;
                  const hasHold =
                    (passenger.holdStatus && passenger.holdStatus !== "No hold") ||
                    matches.some((match) => match.holdCheck && match.holdCheck !== "No hold");
                  const hasVisibleSignals =
                    (passenger.conditionStatus && passenger.conditionStatus !== "Unknown") ||
                    passenger.srcConfirmed ||
                    conflicts > 0;
                  const isActive = activePassenger.id === passenger.id;
                  return (
                    <button
                      key={passenger.id}
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => {
                        setActivePassengerId(passenger.id);
                        setTargetPassengerId(passenger.id);
                      }}
                      className={[
                        "focus-ring w-full rounded-md border px-3 py-2 text-left transition",
                        isActive ? "border-[#145C63] bg-[#145C63]/10 shadow-sm" : "border-transparent bg-card hover:border-border hover:bg-muted"
                      ].join(" ")}
                    >
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <p className="truncate text-sm font-black text-foreground">{passenger.operationalId}</p>
                          </div>
                          <p className="mt-0.5 truncate text-xs font-semibold text-muted-foreground">{personName(passenger) || "Unnamed passenger"}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {hasHold ? (
                            <span
                              className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-amber-300 bg-amber-50 text-amber-800"
                              aria-label="Hold present"
                              title="Hold present"
                            >
                              <ShieldAlert className="h-3.5 w-3.5" />
                            </span>
                          ) : null}
                          <Badge tone={verified ? "success" : "neutral"}>{matches.length}</Badge>
                        </div>
                      </div>
                      {hasVisibleSignals ? (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1">
                          {passenger.conditionStatus && passenger.conditionStatus !== "Unknown" ? <StatusBadge value={passenger.conditionStatus} /> : null}
                          {passenger.srcConfirmed ? <Badge tone="success">SRC</Badge> : null}
                          {conflicts ? <Badge tone="warning">{countLabel(conflicts, "conflict")}</Badge> : null}
                        </div>
                      ) : null}
                    </button>
                  );
                })}
                </div>
              </section>

              <section
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = dragging?.type === "family" ? "copy" : "move";
                  setDropPassengerId(activePassenger.id);
                }}
                onDragLeave={(event) => {
                  const related = event.relatedTarget as Node | null;
                  if (!related || !event.currentTarget.contains(related)) setDropPassengerId("");
                }}
                onDrop={(event) => void handlePassengerDrop(event, activePassenger.id)}
                className={[
                  "overflow-hidden rounded-md border bg-card transition",
                  dropPassengerId === activePassenger.id ? "border-[#145C63] bg-[#145C63]/10" : "border-border"
                ].join(" ")}
              >
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-xs font-black uppercase tracking-wide text-muted-foreground">Active PAX</p>
                    <div className="mt-1 flex min-w-0 items-center gap-2">
                      <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <EntityRef target={{ type: "pax", id: activePassenger.id }} className="shrink-0 text-base font-black">
                        {activePassenger.operationalId}
                      </EntityRef>
                      <span className="shrink-0 text-sm font-semibold text-muted-foreground">·</span>
                      <EntityRef target={{ type: "pax", id: activePassenger.id }} className="text-sm font-semibold text-muted-foreground">
                        {personName(activePassenger) || "Unnamed passenger"}
                      </EntityRef>
                    </div>
                  </div>
                </div>
                <div className="mx-4 mt-3 flex flex-wrap gap-1.5">
                  {activePassenger.conditionStatus && activePassenger.conditionStatus !== "Unknown" ? <StatusBadge value={activePassenger.conditionStatus} /> : null}
                  {activePassenger.srcConfirmed ? <Badge tone="success">SRC</Badge> : null}
                  {activePassengerConflicts ? <Badge tone="warning">{countLabel(activePassengerConflicts, "conflict")}</Badge> : null}
                </div>
                <div
                  className={[
                    "m-3 min-h-[320px] rounded-md border border-dashed p-3",
                    dropPassengerId === activePassenger.id ? "border-[#145C63] bg-[#145C63]/10" : "border-border bg-muted"
                  ].join(" ")}
                >
                  {activePassengerMatches.length ? (
                    <div className="grid content-start gap-2 sm:grid-cols-[repeat(auto-fill,minmax(230px,1fr))]">
                      {activePassengerMatches.map(renderMatchCard)}
                    </div>
                  ) : (
                    <div className="flex min-h-40 items-center justify-center rounded-md border border-dashed border-border bg-card px-3 text-center">
                      <div>
                        <UsersRound className="mx-auto h-5 w-5 text-muted-foreground" />
                        <p className="mt-2 text-sm font-semibold text-muted-foreground">No staged family</p>
                        <p className="mt-1 text-xs font-semibold text-muted-foreground">Drag a Family/NOK record here or use Family pool.</p>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              <section className="overflow-hidden rounded-md border border-border bg-muted">
                <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-black uppercase tracking-wide text-muted-foreground">Family pool</p>
                    <p className="mt-0.5 truncate text-xs font-semibold text-muted-foreground">Target {activePassenger.operationalId}</p>
                  </div>
                </div>
                <div className="grid gap-2 border-b border-border bg-card p-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                    <Input
                      aria-label="Search family pool"
                      className="h-9 pl-9"
                      value={familySearch}
                      placeholder="Family, case, claim"
                      onChange={(event) => setFamilySearch(event.target.value)}
                    />
                  </div>
                  <Select aria-label="Family pool filter" className="h-9" value={poolFilter} onChange={(event) => setPoolFilter(event.target.value)}>
                    <option value="all">All records</option>
                    <option value="available">Available</option>
                    <option value="in-review">In review</option>
                    <option value="conflicts">Conflicts</option>
                    <option value="verified">Verified family</option>
                    <option value="unverified">Unverified family</option>
                  </Select>
                </div>
                <div className="scrollbar-soft grid max-h-[560px] content-start gap-2 overflow-y-auto p-2">
                  {filteredFamilies.length > visibleFamilies.length ? (
                    <div className="rounded-md border border-[#145C63]/25 bg-[#145C63]/10 px-3 py-2 text-xs font-semibold text-[#145C63] dark:text-[#8ED5D7]">
                      Showing {visibleFamilies.length} of {filteredFamilies.length}. Narrow search to reduce the list.
                    </div>
                  ) : null}
                  {visibleFamilies.length ? (
                    visibleFamilies.map(renderFamilyCard)
                  ) : (
                    <EmptyState title="No family records" detail="Change search or filter." />
                  )}
                </div>
              </section>
              </div>
          ) : (
            <EmptyState title={passengers.length ? "No PAX match these filters" : "No PAX records"} detail={passengers.length ? "Adjust search or view filters." : "Passenger / SRC records are required before staging family matches."} />
          )}
        </div>
      </Card>

      {poolOpen ? (
        <DialogSurface
          title="Suggestions & Unassigned"
          description={`${unassignedFamilies.length} family, ${unassignedPassengers.length} passenger, ${suggestions.length} system suggestions`}
          onClose={() => setPoolOpen(false)}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          {({ requestClose }) => (
          <>
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <h2 data-dialog-heading="true" tabIndex={-1} className="truncate text-lg font-black text-foreground">Suggestions &amp; Unassigned</h2>
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {unassignedFamilies.length} family · {unassignedPassengers.length} passenger · {suggestions.length} system suggestions
              </p>
            </div>
            <Button icon={XCircle} variant="ghost" onClick={() => requestClose()}>
              Close
            </Button>
          </div>

          <div className="scrollbar-soft grid flex-1 content-start gap-3 overflow-y-auto px-5 py-4">
            <Field label="Search">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
                <Input className="pl-9" value={familySearch} placeholder="Name, case, flight" onChange={(event) => setFamilySearch(event.target.value)} />
              </div>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Filter">
                <Select value={poolFilter} onChange={(event) => setPoolFilter(event.target.value)}>
                  <option value="all">All records</option>
                  <option value="available">Available</option>
                  <option value="in-review">In review</option>
                  <option value="conflicts">Conflicts</option>
                  <option value="verified">Verified family</option>
                  <option value="unverified">Unverified family</option>
                </Select>
              </Field>
              <Field label="Target PAX">
                <>
                  <Select value={targetPassengerId} onChange={(event) => setTargetPassengerId(event.target.value)}>
                    <option value="">Select PAX</option>
                    {passengers.map((passenger) => (
                      <option key={passenger.id} value={passenger.id}>
                        {passenger.operationalId} | {personName(passenger)}
                      </option>
                    ))}
                  </Select>
                  {targetPassengerId && passengerById.get(targetPassengerId) ? (
                    <p className="truncate text-xs font-semibold text-slate-500">
                      Selected:{" "}
                      <EntityRef target={{ type: "pax", id: targetPassengerId }} className="text-xs text-slate-700" preview={false}>
                        {personLabel(passengerById.get(targetPassengerId))}
                      </EntityRef>
                    </p>
                  ) : null}
                </>
              </Field>
            </div>

            {loading ? (
              <Loading />
            ) : error ? (
              <EmptyState title="Unable to load family records" detail={error} action={<Button onClick={() => void load()}>Retry</Button>} />
            ) : visibleUnassignedFamilies.length ? (
              <>
                <div>
                  <p className="text-sm font-black text-foreground">Unassigned Family/NOK</p>
                  <p className="mt-1 text-xs font-semibold text-muted-foreground">Authoritative family records with no open matching record.</p>
                </div>
                {unassignedFamilies.length > visibleUnassignedFamilies.length ? (
                  <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-900">
                    Showing {visibleUnassignedFamilies.length} of {unassignedFamilies.length}. Narrow search to reduce the list.
                  </div>
                ) : null}
                <div className="grid gap-3">
                  {visibleUnassignedFamilies.map((family) => (
                    <div key={family.id} className="rounded-md border border-border bg-card p-3">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black text-foreground">{personLabel(family)}</p>
                          <p className="mt-1 truncate text-xs font-semibold text-muted-foreground">{compactJoin([family.caseId, family.claimedRelationship, familyPassengerName(family)])}</p>
                        </div>
                        <StatusBadge value={family.verificationStatus} />
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <Button variant="secondary" onClick={() => openFamilyContext(family)}>Inspect</Button>
                        <Button
                          icon={Shuffle}
                          disabled={!canMutate("matching:create") || !targetPassengerId || Boolean(busyKey)}
                          onClick={() => void createMatchFromFamily(family.id, targetPassengerId)}
                        >
                          Add to selected PAX
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <EmptyState title="No unassigned Family/NOK records" detail="Change filters or review records already staged on the matching board." />
            )}

            <div className="border-t border-border pt-4">
              <p className="text-sm font-black text-foreground">Unassigned Passenger/SRC</p>
              <p className="mt-1 text-xs font-semibold text-muted-foreground">Passenger records with no open matching candidate.</p>
              {unassignedPassengers.length ? (
                <div className="mt-3 grid gap-3">
                  {unassignedPassengers.slice(0, 20).map((passenger) => (
                    <div key={passenger.id} className="rounded-md border border-border bg-card p-3">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black text-foreground">{personLabel(passenger)}</p>
                          <p className="mt-1 truncate text-xs font-semibold text-muted-foreground">{compactJoin([passenger.caseId, passenger.flightNumber, passenger.route])}</p>
                        </div>
                        <StatusBadge value={passenger.holdStatus ?? passenger.conditionStatus} />
                      </div>
                      <Button className="mt-3 w-full" icon={Link2} variant="secondary" disabled={!canMutate("matching:create")} onClick={() => openCreateMatch({ passengerRecordId: passenger.id })}>
                        Create potential match
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3"><EmptyState title="No unassigned Passenger/SRC records" detail="All eligible passenger records already have open matching candidates." /></div>
              )}
            </div>

            <div className="border-t border-slate-200 pt-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-sm font-black text-slate-950">System-generated suggestions</p>
                <Filter className="h-4 w-4 text-slate-400" />
              </div>
              <div className="grid gap-3">
                {suggestions.length ? (
                  suggestions.slice(0, 4).map((suggestion, index) => (
                    <div key={`${suggestion.enquiry?.id}-${suggestion.passengerRecord?.id}-${index}`} className="rounded-md border border-slate-200 bg-white p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-black text-slate-900">{scoreLabel(suggestion.matchScore)}</p>
                        <StatusBadge value="Suggested" />
                      </div>
                      <p className="mt-2 truncate text-sm font-bold text-slate-800">
                        {suggestion.enquiry?.id ? (
                          <EntityRef target={{ type: "tec", id: suggestion.enquiry.id }} className="text-sm text-slate-800" preview={false}>
                            {suggestion.enquiry?.callerName ?? "Enquiry"}
                          </EntityRef>
                        ) : (
                          (suggestion.enquiry?.callerName ?? "Enquiry")
                        )}{" "}
                        to{" "}
                        {suggestion.passengerRecord?.id ? (
                          <EntityRef target={{ type: "pax", id: suggestion.passengerRecord.id }} className="text-sm text-slate-800" preview={false}>
                            {suggestion.passengerRecord?.lastName ?? "Passenger"}
                          </EntityRef>
                        ) : (
                          (suggestion.passengerRecord?.lastName ?? "Passenger")
                        )}
                      </p>
                      {suggestion.familyRecord?.id ? (
                        <p className="mt-1 truncate text-xs font-semibold text-slate-500">
                          <EntityRef target={{ type: "fam", id: suggestion.familyRecord.id }} className="text-xs text-slate-600" preview={false}>
                            {personLabel(suggestion.familyRecord)}
                          </EntityRef>
                        </p>
                      ) : null}
                      <Button className="mt-3 w-full" variant="secondary" icon={Link2} disabled={!canMutate("matching:create")} onClick={() => openSuggestion(suggestion)}>
                        Review link
                      </Button>
                    </div>
                  ))
                ) : (
                  <EmptyState title="No system-generated suggestions" detail="No matching-engine result is available. Use the unassigned records above for manual review." />
                )}
              </div>
            </div>

            {unassignedRows.length ? (
              <div className="border-t border-slate-200 pt-4">
                <p className="mb-3 text-sm font-black text-slate-950">Incomplete matching records</p>
                <div className="grid gap-3">{unassignedRows.slice(0, 4).map(renderMatchCard)}</div>
              </div>
            ) : null}
          </div>
          </>
          )}
        </DialogSurface>
      ) : null}

      {contextOpen && inspectedEntity && inspectorTarget ? (
        <DialogSurface
          title="Record Inspector"
          description={`${inspectedEntity.typeLabel} · ${inspectedEntity.title}`}
          onClose={() => { setContextOpen(false); setInspectorTarget(null); }}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          {({ requestClose }) => (
          <>
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <h2 data-dialog-heading="true" tabIndex={-1} className="truncate text-lg font-black text-foreground">Record Inspector</h2>
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {inspectedEntity.typeLabel} · {inspectedEntity.title}
              </p>
            </div>
            <Button
              icon={XCircle}
              variant="ghost"
              onClick={() => requestClose()}
            >
              Close
            </Button>
          </div>

          <div className="scrollbar-soft flex-1 overflow-y-auto px-5 py-4">{renderEntityInspector(inspectedEntity, inspectorTarget)}</div>
          </>
          )}
        </DialogSurface>
      ) : null}

      {drawerOpen ? (
        <DialogSurface
          title="Create Potential Match"
          description={activeSession?.operationalId ?? "No active session"}
          dirty={Boolean(formBaseline && JSON.stringify(form) !== formBaseline)}
          busy={saving}
          onClose={() => setDrawerOpen(false)}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          {({ requestClose }) => (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h2 data-dialog-heading="true" tabIndex={-1} className="truncate text-lg font-black text-foreground">Create Potential Match</h2>
                <p className="mt-1 truncate text-sm text-muted-foreground">{activeSession?.operationalId ?? "No active session"}</p>
              </div>
              <Button icon={XCircle} variant="ghost" disabled={saving} onClick={() => requestClose()}>
                Close
              </Button>
            </div>

            <div className="scrollbar-soft grid flex-1 gap-3 overflow-y-auto px-5 py-4">
              <ErrorSummary title="Potential match could not be created" errors={formError ? [{ message: formError, fieldId: !form.familyRecordId ? "match-family" : !form.passengerRecordId ? "match-passenger" : undefined }] : []} />
              <Field label="Enquiry">
                <>
                  <Select value={form.enquiryId ?? ""} onChange={(event) => setForm((current) => ({ ...current, enquiryId: event.target.value }))}>
                    <option value="">None</option>
                    {enquiries.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.operationalId} | {item.callerName}
                      </option>
                    ))}
                  </Select>
                  {form.enquiryId && enquiryById.get(form.enquiryId) ? (
                    <EntityRef target={{ type: "tec", id: form.enquiryId }} className="text-xs text-slate-700" preview={false}>
                      {enquiryLabel(enquiryById.get(form.enquiryId))}
                    </EntityRef>
                  ) : null}
                </>
              </Field>
              <Field id="match-family" label="Family/NOK record" required error={formError && !form.familyRecordId ? "Family/NOK record is required." : undefined}>
                <>
                  <Select id="match-family" required aria-required="true" aria-invalid={Boolean(formError && !form.familyRecordId)} value={form.familyRecordId ?? ""} onChange={(event) => { setFormError(""); setForm((current) => ({ ...current, familyRecordId: event.target.value })); }}>
                    <option value="">None</option>
                    {families.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.operationalId} | {item.lastName}, {item.firstName}
                      </option>
                    ))}
                  </Select>
                  {form.familyRecordId && familyById.get(form.familyRecordId) ? (
                    <EntityRef target={{ type: "fam", id: form.familyRecordId }} className="text-xs text-slate-700" preview={false}>
                      {personLabel(familyById.get(form.familyRecordId))}
                    </EntityRef>
                  ) : null}
                </>
              </Field>
              <Field id="match-passenger" label="Passenger/Crew record" required error={formError && !form.passengerRecordId ? "Passenger/Crew record is required." : undefined}>
                <>
                  <Select id="match-passenger" required aria-required="true" aria-invalid={Boolean(formError && !form.passengerRecordId)} value={form.passengerRecordId ?? ""} onChange={(event) => { setFormError(""); setForm((current) => ({ ...current, passengerRecordId: event.target.value })); }}>
                    <option value="">None</option>
                    {passengers.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.operationalId} | {item.lastName}, {item.firstName}
                      </option>
                    ))}
                  </Select>
                  {form.passengerRecordId && passengerById.get(form.passengerRecordId) ? (
                    <EntityRef target={{ type: "pax", id: form.passengerRecordId }} className="text-xs text-slate-700" preview={false}>
                      {personLabel(passengerById.get(form.passengerRecordId))}
                    </EntityRef>
                  ) : null}
                </>
              </Field>
              <div className="rounded-md border border-border bg-muted px-3 py-2">
                <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Initial workflow state</p>
                <div className="mt-1 flex flex-wrap gap-2"><StatusBadge value="Potential match" /><StatusBadge value="No hold" /></div>
                <p className="mt-1 text-xs font-semibold text-muted-foreground">Verification, rejection and holds use dedicated decision actions after creation.</p>
              </div>
              <Field label="Match score">
                <Input
                  inputMode="decimal"
                  placeholder="No score"
                  value={form.matchScore ?? ""}
                  onChange={(event) => {
                    setFormError("");
                    setForm((current) => ({
                      ...current,
                      matchScore: event.target.value,
                      matchScoreSource: event.target.value.trim() ? "manual" : "none"
                    }));
                  }}
                />
                <p className="mt-1 text-xs font-semibold text-muted-foreground">
                  {form.matchScoreSource === "system"
                    ? "System-calculated score from the selected suggestion."
                    : form.matchScoreSource === "manual"
                      ? "Manually entered score."
                      : "No confidence score. Manual matches do not receive a default value."}
                </p>
              </Field>
              <Field label="Match basis">
                <Textarea value={form.matchBasis ?? ""} onChange={(event) => setForm((current) => ({ ...current, matchBasis: event.target.value }))} />
              </Field>
            </div>

            <div className="border-t border-border bg-card p-4">
              <Button className="w-full" icon={Link2} variant="primary" disabled={!canMutate("matching:create") || saving} onClick={savePotentialMatch}>
                {saving ? "Creating" : "Create potential match"}
              </Button>
            </div>
          </>
          )}
        </DialogSurface>
      ) : null}

      {decision ? (
        <DialogSurface
          title={decisionTitle(decision.actionName)}
          description={decision.row.operationalId}
          dirty={Boolean(decisionBaseline && JSON.stringify({ ...decision, error: "" }) !== decisionBaseline)}
          busy={Boolean(busyKey)}
          onClose={() => setDecision(null)}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-border bg-card text-foreground shadow-2xl"
        >
          {({ requestClose }) => (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h2 data-dialog-heading="true" tabIndex={-1} className="truncate text-lg font-black text-foreground">{decisionTitle(decision.actionName)}</h2>
                <p className="mt-1 truncate text-sm text-muted-foreground">{decision.row.operationalId}</p>
              </div>
              <Button icon={XCircle} variant="ghost" disabled={Boolean(busyKey)} onClick={() => requestClose()}>
                Close
              </Button>
            </div>
            <div className="scrollbar-soft grid flex-1 content-start gap-4 overflow-y-auto px-5 py-4">
              <ErrorSummary title="Decision could not be submitted" errors={decision.error ? [{ message: decision.error, fieldId: "matching-decision-basis" }] : []} />
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-950">
                This controlled action updates {decision.row.operationalId} and is recorded in Timeline/Audit. Review the selected action and decision basis before confirming.
              </p>
              <div className="grid gap-2">
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Family / NOK</p>
                  <p className="mt-1 truncate text-sm font-bold text-slate-900">
                    {linkedFamily(decision.row) ? (
                      <EntityRef target={{ type: "fam", id: linkedFamily(decision.row)?.id }} className="text-sm text-slate-900" preview={false}>
                        {personLabel(linkedFamily(decision.row))}
                      </EntityRef>
                    ) : (
                      personLabel(linkedFamily(decision.row))
                    )}
                  </p>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Passenger / crew</p>
                  <p className="mt-1 truncate text-sm font-bold text-slate-900">
                    {linkedPassenger(decision.row) ? (
                      <EntityRef target={{ type: "pax", id: linkedPassenger(decision.row)?.id }} className="text-sm text-slate-900" preview={false}>
                        {personLabel(linkedPassenger(decision.row))}
                      </EntityRef>
                    ) : (
                      personLabel(linkedPassenger(decision.row))
                    )}
                  </p>
                </div>
              </div>
              {decision.actionName === "hold" ? (
                <Field label="Hold type" required>
                  <Select value={decision.holdCheck} onChange={(event) => setDecision((current) => (current ? { ...current, holdCheck: event.target.value, error: "" } : current))}>
                    {holdOptions.length ? (
                      holdOptions.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))
                    ) : (
                      <option value="Identity verification hold">Identity verification hold</option>
                    )}
                  </Select>
                </Field>
              ) : null}
              <Field id="matching-decision-basis" label="Decision basis" required error={decision.error && !decision.decisionNotes.trim() ? "Decision basis is required." : undefined}>
                <Textarea
                  value={decision.decisionNotes}
                  onChange={(event) => setDecision((current) => (current ? { ...current, decisionNotes: event.target.value, error: "" } : current))}
                />
              </Field>
              <div className="rounded-md border border-slate-200 bg-white p-3">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Current basis</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">{decision.row.matchBasis || "No match basis recorded."}</p>
              </div>
            </div>
            <div className="border-t border-border bg-card p-4">
              <Button
                className="w-full"
                icon={decision.actionName === "reject" ? XCircle : decision.actionName === "hold" ? ShieldAlert : CheckCircle2}
                variant={decision.actionName === "reject" ? "danger" : decision.actionName === "hold" ? "warning" : decision.actionName === "verify" ? "success" : "primary"}
                disabled={Boolean(busyKey) || !activeSessionWritable}
                onClick={() => void runDecision(decision)}
              >
                {busyKey ? "Submitting" : decisionActionLabel(decision.actionName)}
              </Button>
            </div>
          </>
          )}
        </DialogSurface>
      ) : null}

      {hoverPreviewAllowed && hoverPreview && hoverEntity && hoverPreviewStyle ? (
        <div
          className="pointer-events-none fixed z-[60] max-h-[230px] w-[320px] overflow-hidden rounded-md border border-border bg-card p-3 text-foreground shadow-xl"
          style={{ ...hoverPreviewStyle, width: hoverPreviewWidth }}
        >
          {renderHoverPreview(hoverEntity)}
        </div>
      ) : null}
    </div>
  );
}

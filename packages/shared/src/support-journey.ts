import type { DashboardAvailability } from "./dashboard-contracts.js";
export type JourneyEntity = "enquiry" | "family" | "passenger" | "claim" | "release";
export type JourneyRecord = {
  id: string; reference: string; title: string; association: "Recorded link" | "Shared reference";
  href: string; facts: Array<{ label: string; value: string }>;
};
export type JourneySection = { items: JourneyRecord[]; total: number; limit: number };
export type JourneyStep = { key: string; title: string; state: string; detail: string; expectedRole: string; href: string | null };
export type SupportJourney = {
  loadedAt: string; reference: string; incidentReference: string;
  enquiries: DashboardAvailability<JourneySection>; families: DashboardAvailability<JourneySection>;
  passengers: DashboardAvailability<JourneySection>; matches: DashboardAvailability<JourneySection>;
  releases: DashboardAvailability<JourneySection>; followUp: DashboardAvailability<JourneySection>;
  activity: DashboardAvailability<JourneySection>; steps: JourneyStep[];
};
export type SupportJourneyResult = DashboardAvailability<SupportJourney>;

export function assertSupportJourneyResult(input: unknown): asserts input is SupportJourneyResult {
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const validHref = (value: unknown) => typeof value === 'string' && /^\/(?:tec-intake|family-nok|passenger-src|matching|release-control|requests|timeline)(?:\?[^#\s]*)?$/.test(value);
  const failure = () => { throw new Error('Support context is incomplete or invalid'); };
  if (!object(input)) return failure();
  if (input.status === 'unavailable') return;
  const data = input.value;
  if (input.status !== 'available' || !object(data) || typeof data.loadedAt !== 'string' || !Number.isFinite(Date.parse(data.loadedAt)) || typeof data.reference !== 'string' || typeof data.incidentReference !== 'string') return failure();
  for (const key of ['enquiries','families','passengers','matches','releases','followUp','activity']) {
    const source=data[key]; if(!object(source))return failure(); if(source.status==='unavailable')continue;
    const list=source.value;
    if(source.status!=='available'||!object(list)||!Array.isArray(list.items)||typeof list.total!=='number'||!Number.isInteger(list.total)||list.total<list.items.length||typeof list.limit!=='number'||!Number.isInteger(list.limit)||list.limit<list.items.length)return failure();
    for(const row of list.items) {
      if(!object(row)||typeof row.id!=='string'||typeof row.title!=='string'||typeof row.reference!=='string'||!['Recorded link','Shared reference'].includes(String(row.association))||!validHref(row.href)||!Array.isArray(row.facts)||row.facts.some(item=>!object(item)||typeof item.label!=='string'||typeof item.value!=='string'))return failure();
    }
  }
  if(!Array.isArray(data.steps)||data.steps.some(step=>!object(step)||typeof step.key!=='string'||typeof step.title!=='string'||typeof step.state!=='string'||typeof step.detail!=='string'||typeof step.expectedRole!=='string'||step.href!==null&&!validHref(step.href)))return failure();
}

const routeParams: Record<string, string[]> = {
  '/tec-intake': ['focus','q','status','page','size','sort','direction'],
  '/family-nok': ['focus','fromEnquiry','q','status','page','size','sort','direction'],
  '/passenger-src': ['focus','q','status','page','size','sort','direction'],
  '/matching': ['claimId','q','state','relationship','offset'],
  '/release-control': ['releaseId','claimId','q','status','eligibility','actionType','offset'],
  '/documents': ['versionId','view'], '/evidence': ['incidentId','evidenceId'],
  '/reports': ['incidentId','generationId'], '/reports/after-action': ['incidentId','revisionId','artifactId'],
  '/sessions': ['focus'], '/dashboard': ['view'], '/requests': ['requestId'], '/timeline': ['eventId']
};
/** A return target is a bounded local specialist/workspace route, never an external URL. */
export function safeJourneyReturn(value: string | null | undefined): string | null {
  if (!value || value.length > 2000 || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const url = new URL(value,'https://journey.local');
    if (url.origin !== 'https://journey.local' || !routeParams[url.pathname] || url.hash) return null;
    let valid=true; url.searchParams.forEach((entry,key)=>{ if(!routeParams[url.pathname]!.includes(key)||entry.length>200)valid=false; });
    if(!valid)return null;
    return `${url.pathname}${url.search}`;
  } catch { return null; }
}
export function journeyQueuePath(pathname: string, params: URLSearchParams): string {
  const clean = new URLSearchParams(params); clean.delete('returnTo');
  return safeJourneyReturn(`${pathname}${clean.size ? `?${clean}` : ''}`) ?? pathname;
}
export function withJourneyReturn(destination: string, origin: string): string {
  const safe = safeJourneyReturn(origin);
  if (!safe) return destination;
  const url = new URL(destination,'https://journey.local');
  url.searchParams.set('returnTo',safe);
  return `${url.pathname}${url.search}`;
}
export function boundedQueueNumber(value: string | null, fallback: number, max: number) {
  const number = Number(value); return value && Number.isInteger(number) && number >= 0 && number <= max ? number : fallback;
}

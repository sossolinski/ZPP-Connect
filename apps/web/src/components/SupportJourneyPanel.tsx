import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { JourneyEntity, SupportJourneyResult, JourneySection } from '@zpp/shared';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { journeyQueuePath, safeJourneyReturn, withJourneyReturn } from '../lib/journey-navigation';
import { AlertBox, Button, Loading } from './ui';

export function JourneyReturnLink() {
  const [params] = useSearchParams(); const back = safeJourneyReturn(params.get('returnTo'));
  return back ? <Link className="focus-ring mb-3 inline-block text-sm font-bold underline" to={back}>Return to previous work</Link> : null;
}

export function SupportJourneyPanel({entity,id,revision}:{entity:JourneyEntity;id:string;revision?:string|number}) {
  const {activeSession} = useApp(); const location = useLocation(); const [params] = useSearchParams();
  const [result,setResult] = useState<SupportJourneyResult|null>(null), [error,setError] = useState(''), [attempt,setAttempt] = useState(0);
  const [loadedScope,setLoadedScope] = useState('');
  const scope = `${activeSession?.id}:${entity}:${id}:${revision ?? ''}:${attempt}`;
  useEffect(()=>{
    let cancelled=false; setResult(null);setError('');
    if (!activeSession || !id) return;
    void api.supportJourney(activeSession.id,entity,id).then(value=>{if(!cancelled){setLoadedScope(scope);setResult(value);}}).catch(()=>{if(!cancelled){setLoadedScope(scope);setError('Case support context could not be loaded. Retry before continuing from this context.');}});
    return ()=>{cancelled=true;};
  },[activeSession?.id,entity,id,revision,attempt]);
  const origin = journeyQueuePath(location.pathname,params);
  const link = (href:string)=>withJourneyReturn(href,origin);
  if(error && loadedScope===scope) return <div className="mb-4"><AlertBox tone="danger">{error}</AlertBox><Button onClick={()=>setAttempt(value=>value+1)}>Retry case context</Button></div>;
  if(!result || loadedScope!==scope) return <div className="mb-4"><Loading label="Loading case support context" /></div>;
  if(result.status==='unavailable') return <p className="mb-4 text-sm text-muted-foreground">Related support context unavailable. Continue using the source record below.</p>;
  const data=result.value;
  const sources = [ ['enquiries','Reported enquiry'],['families','Contact / relationship'],['passengers','Passenger / source'],['matches','Suggestion / human decision'],['releases','Release / reunification'],['followUp','Responsibility / follow-up'],['activity','Last significant actions'] ] as const;
  function rows(value:JourneySection) {
    return value.items.length ? <ul className="mt-2 grid gap-2">{value.items.map(row=><li key={row.id} className="min-w-0 rounded border border-border bg-card p-2"><Link className="focus-ring break-words font-bold underline" to={link(row.href)}>{row.title} · {row.reference}</Link><p className="mt-1 text-xs text-muted-foreground">{row.association === 'Shared reference' ? 'Shared case reference — not identity or relationship proof' : 'Recorded source link'}</p><dl className="mt-2 grid gap-1 text-xs">{row.facts.map(item=><div key={item.label} className="break-words"><dt className="inline font-bold">{item.label}: </dt><dd className="inline">{item.value}</dd></div>)}</dl></li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">No related records recorded in this permitted source.</p>;
  }
  return <section aria-label="Case support journey" data-testid="support-journey" className="mb-4 min-w-0 rounded-md border border-[#145C63]/30 bg-[#145C63]/5 p-3">
    <div className="flex flex-wrap justify-between gap-2"><h3 className="font-black">Case support journey</h3><Button size="sm" onClick={()=>setAttempt(value=>value+1)}>Refresh case context</Button></div>
    <p className="mt-1 break-words text-xs text-muted-foreground">{data.incidentReference} · {data.reference} · Snapshot {new Date(data.loadedAt).toLocaleString()}</p>
    <p className="mt-2 text-xs font-semibold">Reported facts, relationship verification, source confirmation, system suggestions and human decisions remain separate.</p>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">{(['families','passengers','matches','releases'] as const).map(key=>{
      const source=data[key]; if(source.status!=='available' || !source.value.items.length)return null;
      const row=source.value.items[0]!;
      return <div key={key} className="min-w-0 rounded border border-border bg-card p-2 text-xs"><Link className="focus-ring break-words font-bold underline" to={link(row.href)}>{row.title} · {row.reference}</Link>{row.facts.slice(0,key==='families'?2:4).map(item=><p key={item.label} className="mt-1 break-words"><strong>{item.label}: </strong>{item.value}</p>)}{row.association==='Shared reference'?<p className="mt-1 font-semibold">Shared reference — not identity proof.</p>:null}</div>;
    })}</div>
    {data.steps.length ? <details open className="mt-3"><summary className="focus-ring cursor-pointer text-sm font-bold">Next steps / blockers ({data.steps.length})</summary><ul className="mt-2 grid gap-2">{data.steps.map(step=><li key={step.key} className="rounded border border-border bg-card p-2 text-xs"><p className="font-bold">{step.title} · {step.state}</p><p className="mt-1">{step.detail}</p><p className="mt-1 text-muted-foreground">Expected function: {step.expectedRole}. Assigned person is recorded separately in follow-up.</p>{step.href ? <Link className="focus-ring mt-1 inline-block font-bold underline" to={link(step.href)}>Continue: {step.title}</Link> : <p className="mt-1 font-semibold">An authorized operator must continue this step.</p>}</li>)}</ul></details> : null}
    <div className="mt-3 grid gap-2">{sources.map(([key,label])=>{
      const source=data[key];
      return source.status==='unavailable' ? <p key={key} className="text-xs text-muted-foreground">{label}: unavailable for your account.</p> : <details key={key} open={key==='followUp'}><summary className="focus-ring cursor-pointer text-xs font-bold">{label} · {source.value.items.length} of {source.value.total} shown</summary>{rows(source.value)}{key==='followUp' && !source.value.items.length ? <p className="mt-1 text-xs font-semibold">Needs assignment — no responsible person is recorded in related open support work.</p> : null}</details>;
    })}</div>
  </section>;
}

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "./api";
import { useApp } from "./app-context";
import type { SessionRecord } from "./types";

/** Local historical record context never changes the operational active incident. */
export function useRecordIncident() {
  const { activeSession } = useApp();
  const [params] = useSearchParams();
  const requested = params.get("incidentId");
  const [result, setResult] = useState<{ id: string; incident?: SessionRecord; error?: string }>();
  useEffect(() => {
    if (requested === null) return;
    let active = true;
    if (!requested || requested.length > 100) {
      setResult({ id: requested, error: "Incident context unavailable: invalid link." }); return;
    }
    void api.recordIncident(requested).then(incident => { if (active) setResult({ id: requested, incident }); })
      .catch(e => { if (active) setResult({ id: requested, error: `Incident context unavailable: ${e.message}` }); });
    return () => { active = false; };
  }, [requested]);
  return requested === null ? { incident: activeSession, error: "", loading: false }
    : { incident: result?.id === requested ? result.incident : undefined,
      error: result?.id === requested ? result.error : "", loading: result?.id !== requested };
}

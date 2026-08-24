import { useState } from "react";
import { Download } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { AlertBox, Button, Card } from "../components/ui";

const exports = [
  { type: "session-package", label: "Session package CSV" },
  { type: "enquiry-log", label: "Enquiry log" },
  { type: "family-register", label: "Family/NOK register" },
  { type: "passenger-register", label: "Passenger/Crew register" },
  { type: "matching-log", label: "Matching log" },
  { type: "requests-log", label: "Requests log" },
  { type: "audit-log", label: "Audit log" },
  { type: "pdf-session-summary", label: "PDF session summary" },
  { type: "aar-draft", label: "Exercise/AAR draft" }
];

export function ReportsPage() {
  const { activeSession, can } = useApp();
  const [error, setError] = useState("");

  async function download(type: string) {
    setError("");
    try {
      if (!activeSession?.id) throw new Error("Select an Incident before creating an export.");
      await api.downloadExport(type, activeSession.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create export.");
    }
  }

  return (
    <div className="grid gap-5">
      <Card>
        <div className="grid gap-4 p-4">
          <AlertBox>
            Export protected information only when it is needed for handover, briefing or authorized review.
          </AlertBox>
          {error ? <AlertBox tone="danger">{error}</AlertBox> : null}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {exports.map((item) => {
              const unavailableFormat = item.type === "pdf-session-summary" || item.type === "aar-draft";
              return (
                <div key={item.type} className="rounded-md border border-border bg-card p-4 text-foreground">
                  <p className="text-sm font-black text-foreground">{item.label}</p>
                  <p className="mt-1 text-xs font-semibold text-muted-foreground">
                    {unavailableFormat ? "This report format is not available right now" : "CSV export for authorized operational use"}
                  </p>
                  <Button className="mt-3" icon={Download} variant="secondary" disabled={!can("export:create") || unavailableFormat} onClick={() => download(item.type)}>
                    {unavailableFormat ? "Unavailable" : "Export"}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      </Card>
    </div>
  );
}

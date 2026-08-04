import { AlertTriangle, BookOpenCheck, CalendarDays, ClipboardList, FileText, HeartHandshake, RadioTower, UsersRound } from "lucide-react";
import { dashboardStats, priorityAttention, recentActivity } from "../data/dashboard";
import { LinkedAction, PageIntro, Panel, PanelBody, PriorityBadge, SectionHeader, StatCard, Timeline } from "../components/portal";

const statIcons = [RadioTower, HeartHandshake, UsersRound, ClipboardList, CalendarDays, BookOpenCheck, FileText];

export function PortalDashboardPage() {
  return (
    <>
      <PageIntro
        eyebrow="Operational overview"
        title="Dashboard"
        description="Operational snapshot and items requiring action."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {dashboardStats.map((item, index) => (
          <StatCard key={item.label} item={item} icon={statIcons[index]} />
        ))}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel>
          <PanelBody>
            <SectionHeader title="Priority Attention" />
            <div className="mt-4 grid gap-3">
              {priorityAttention.map((item) => (
                <article key={item.title} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-700" />
                        <h3 className="font-black text-[#0B1F3A]">{item.title}</h3>
                        <PriorityBadge value={item.priority} />
                      </div>
                      <p className="mt-2 text-sm font-semibold text-slate-600">{item.detail}</p>
                      <p className="mt-2 text-xs font-black uppercase tracking-wide text-slate-500">Owner: {item.owner}</p>
                    </div>
                    <LinkedAction to={item.link}>Open</LinkedAction>
                  </div>
                </article>
              ))}
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelBody>
            <SectionHeader title="Recent Activity" />
            <div className="mt-4">
              <Timeline items={recentActivity} />
            </div>
          </PanelBody>
        </Panel>
      </div>
    </>
  );
}

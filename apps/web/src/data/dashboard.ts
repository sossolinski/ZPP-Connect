import type { StatItem, TimelineItem } from "../lib/portal-types";

export const dashboardStats: StatItem[] = [
  { label: "Active ERP Status", value: "Monitoring", detail: "ERP-2026-001 under coordinator watch", tone: "petrol" },
  { label: "Open Next of Kin Cases", value: "18", detail: "4 require verification before contact", tone: "warning" },
  { label: "Members Available", value: "42", detail: "26 available for the next 12 hours", tone: "success" },
  { label: "Pending Assignments", value: "11", detail: "3 escalated tasks need owner confirmation", tone: "danger" },
  { label: "Upcoming Rostered Shifts", value: "9", detail: "Next shift change at 14:00 local", tone: "gold" },
  { label: "Training Completion", value: "87%", detail: "TEC and welfare modules need refresh", tone: "navy" },
  { label: "Documents to Review", value: "6", detail: "2 role cards and 1 activation message set", tone: "warning" }
];

export const priorityAttention = [
  {
    title: "Verification queue above threshold",
    detail: "Four Next of Kin cases are waiting for identity and relationship verification.",
    owner: "ZPP Coordinator",
    priority: "Critical",
    link: "/family-nok"
  },
  {
    title: "Welfare Support coverage gap",
    detail: "Evening roster has one open restricted role requiring PFA awareness.",
    owner: "ZPP Group Leader",
    priority: "Urgent",
    link: "/rostering"
  },
  {
    title: "Activation message review due",
    detail: "Draft notification pack needs coordinator approval before exercise release.",
    owner: "System Admin",
    priority: "Normal",
    link: "/documents"
  }
];

export const recentActivity: TimelineItem[] = [
  {
    time: "09:42",
    title: "Roster risk updated",
    detail: "Documentation Cell shift moved from Medium to Low risk after two confirmations.",
    tone: "success"
  },
  {
    time: "09:18",
    title: "Case sensitivity changed",
    detail: "Family A-014 marked Coordinator Only pending verification review.",
    tone: "warning"
  },
  {
    time: "08:55",
    title: "Briefing note added",
    detail: "Next operational briefing scheduled and published to active event timeline.",
    tone: "info"
  },
  {
    time: "08:30",
    title: "Training reminder generated",
    detail: "Members with expiring TEC procedure training were flagged for refresh.",
    tone: "neutral"
  }
];

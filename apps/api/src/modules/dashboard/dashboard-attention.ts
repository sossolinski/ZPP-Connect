import type { DashboardAttentionItem, DashboardOperationalStatus } from "@zpp/shared";

/** Source rows are already incident/permission filtered by the read model. */
export function dashboardAttention(sources: Array<{ label: string; items: DashboardAttentionItem[] }>): DashboardOperationalStatus["attention"] {
  if (!sources.length) return { status: "unavailable" };
  const items = new Map<string, DashboardAttentionItem>();
  for (const source of sources) for (const item of source.items) {
    const existing = items.get(item.key);
    items.set(item.key, existing ? { ...existing, detail: `${existing.detail} · ${item.detail}` } : item);
  }
  return { status: "available", value: { items: [...items.values()], checkedSources: sources.map(source => source.label), limitPerSource: 5 } };
}

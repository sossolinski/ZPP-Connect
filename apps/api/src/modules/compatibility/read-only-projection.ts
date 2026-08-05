type Row = Record<string, any>;

export function syncProjectionRow(target: Row[], record: Row) {
  const index = target.findIndex((item) => item.id === record.id);
  if (index >= 0) target[index] = { ...record };
  else target.unshift({ ...record });
}

export function mergeProjectionPage(target: Row[], incidentId: string, records: Row[], offset: number) {
  if (offset === 0) {
    for (let index = target.length - 1; index >= 0; index -= 1) {
      if (target[index]?.sessionId === incidentId) target.splice(index, 1);
    }
  }
  records.forEach((record) => syncProjectionRow(target, record));
}

export async function hydrateReadOnlyProjection(
  target: Row[],
  incidentId: string,
  loadPage: (offset: number) => Promise<{ total: number; data: Row[] }>
) {
  let offset = 0;
  let total = 0;
  const records: Row[] = [];
  do {
    const page = await loadPage(offset);
    total = page.total;
    records.push(...page.data);
    if (page.data.length === 0) break;
    offset += page.data.length;
  } while (offset < total);
  mergeProjectionPage(target, incidentId, records, 0);
}

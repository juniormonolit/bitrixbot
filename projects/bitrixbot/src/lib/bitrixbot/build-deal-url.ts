export function buildDealUrl(
  dealId: string | number | null | undefined
): string {
  if (dealId === null || dealId === undefined) return "Сделка: не определена";
  const v = String(dealId).trim();
  if (!v) return "Сделка: не определена";
  return `https://td.monolit-crm.ru/crm/deal/details/${v}/`;
}


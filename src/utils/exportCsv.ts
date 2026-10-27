// ============================================================================
// Canastica CSV / Excel Export Utility (With Date Range Filtering)
// ============================================================================

import { HouseholdMember, Purchase } from '../types/grocery';

export function exportPurchasesToCsv(
  purchases: Purchase[],
  members: HouseholdMember[],
  startDate: string,
  endDate: string
): number {
  const filtered = purchases.filter(
    (p) => p.purchaseDate >= startDate && p.purchaseDate <= endDate
  );

  const memberMap = new Map(members.map((m) => [m.id, m.name]));

  const headers = [
    'Purchase Date',
    'Supermarket',
    'Paid By Member',
    'Raw Receipt Code',
    'Normalized Product Name',
    'Canonical Product Group',
    'Category',
    'Quantity',
    'Unit',
    'Normalized Base Qty',
    'Base Unit',
    'Unit Price (USD)',
    'Item Total (USD)',
    'Expense Type',
    'Receipt Grand Total (USD)',
  ];

  const rows: string[][] = [];

  for (const purchase of filtered) {
    const buyerName = memberMap.get(purchase.createdBy) || 'Household Member';
    for (const item of purchase.items) {
      rows.push([
        purchase.purchaseDate,
        purchase.supermarket,
        buyerName,
        item.rawReceiptName || item.normalizedName,
        item.normalizedName,
        item.canonicalName,
        item.category,
        String(item.quantity),
        item.unit,
        String(item.baseUnitQuantity),
        item.baseUnit,
        item.unitPrice.toFixed(2),
        item.totalPrice.toFixed(2),
        item.isShared ? 'Shared Household' : 'Personal',
        purchase.totalAmount.toFixed(2),
      ]);
    }
  }

  const escapeCsvCell = (val: string) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  const csvContent =
    '\uFEFF' + // UTF-8 BOM for Microsoft Excel compatibility
    [headers.join(','), ...rows.map((r) => r.map(escapeCsvCell).join(','))].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Canastica_Compras_${startDate}_to_${endDate}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return rows.length;
}

import React, { useMemo, useState } from 'react';
import { PiggyBank, Store } from 'lucide-react';
import { buildPriceComparisons, COMPARISON_WINDOW_DAYS, potentialSavingsThisMonth } from '../lib/priceComparison';
import { CurrencyCode, Purchase } from '../types/grocery';
import { formatCurrency } from '../utils/formatters';

interface StoreComparisonCardProps {
  purchases: Purchase[];
  currency: CurrencyCode;
}

const INITIAL_ROWS = 6;

/** Same product, different supermarkets: last and average price per kg / L / unit. */
export const StoreComparisonCard: React.FC<StoreComparisonCardProps> = ({ purchases, currency }) => {
  const comparisons = useMemo(() => buildPriceComparisons(purchases), [purchases]);
  const savings = useMemo(() => potentialSavingsThisMonth(purchases, comparisons), [purchases, comparisons]);
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? comparisons : comparisons.slice(0, INITIAL_ROWS);

  return (
    <div className="liquid-glass rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
          <Store className="w-3.5 h-3.5" /> Comparador entre súpers
        </h3>
        <span className="text-[10px] text-[var(--text-muted)]">Últimos {COMPARISON_WINDOW_DAYS} días</span>
      </div>

      {savings.total > 0 && (
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-2 flex items-center gap-2 text-sm">
          <PiggyBank className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>
            Si hubieras comprado todo en el más barato, ahorrabas <strong>{formatCurrency(savings.total, currency)}</strong> este mes.
          </span>
        </div>
      )}

      {comparisons.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          Cuando compres el mismo producto en al menos dos súpers distintos, aquí verás dónde sale más barato.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((c) => (
            <div key={c.key} className="liquid-glass-subtle rounded-lg p-2.5 space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-bold truncate">{c.name}</p>
                {c.spreadPct > 0 && (
                  <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 shrink-0">
                    {c.spreadPct}% más barato en {c.cheapest.store}
                  </span>
                )}
              </div>
              <table className="w-full text-xs tabular-nums">
                <thead>
                  <tr className="text-[10px] text-[var(--text-muted)] text-left">
                    <th className="font-semibold py-0.5">Súper</th>
                    <th className="font-semibold text-right">Último /{c.unitLabel}</th>
                    <th className="font-semibold text-right">Promedio /{c.unitLabel}</th>
                  </tr>
                </thead>
                <tbody>
                  {c.stores.map((s, i) => (
                    <tr key={s.store} className={i === 0 ? 'font-bold text-emerald-700 dark:text-emerald-300' : ''}>
                      <td className="py-0.5 truncate max-w-[9rem]">{s.store}</td>
                      <td className="text-right">{formatCurrency(s.lastPrice, currency)}</td>
                      <td className="text-right">{formatCurrency(s.avgPrice, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {comparisons.length > INITIAL_ROWS && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="w-full min-h-[40px] text-xs font-semibold text-avocado-700 dark:text-avocado-400"
            >
              {showAll ? 'Ver menos' : `Ver los ${comparisons.length} productos`}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

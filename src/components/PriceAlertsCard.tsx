import React from 'react';
import { BellOff, Check, TrendingUp } from 'lucide-react';
import type { PriceAlert } from '../lib/priceAlerts';
import { CurrencyCode } from '../types/grocery';
import { formatCurrency } from '../utils/formatters';

interface PriceAlertsCardProps {
  alerts: PriceAlert[];
  currency: CurrencyCode;
  threshold: number;
  isAdmin: boolean;
  onDismiss: (ids: string[]) => void;
  onMute: (alert: PriceAlert) => void;
  onChangeThreshold: (pct: number) => void;
}

const THRESHOLDS = [5, 10, 15, 20, 30];

/** Dashboard card: "El arroz subió 15 % en Palí (₡1.200 → ₡1.380)". Only unseen alerts are shown. */
export const PriceAlertsCard: React.FC<PriceAlertsCardProps> = ({
  alerts,
  currency,
  threshold,
  isAdmin,
  onDismiss,
  onMute,
  onChangeThreshold,
}) => {
  const unseen = alerts.filter((a) => !a.seen);
  if (unseen.length === 0) return null;

  return (
    <div className="liquid-glass rounded-xl p-3.5 space-y-2.5 border border-rose-500/30 mb-3.5 animate-spring-in">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 text-rose-700 dark:text-rose-300">
          <TrendingUp className="w-3.5 h-3.5" /> {unseen.length === 1 ? 'Subió un precio' : `Subieron ${unseen.length} precios`}
        </h3>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <label className="text-[11px] text-[var(--text-muted)] flex items-center gap-1">
              Avisar desde
              <select
                value={threshold}
                onChange={(e) => onChangeThreshold(Number(e.target.value))}
                className="bg-transparent font-semibold outline-none"
                aria-label="Umbral de alerta de precio"
              >
                {[...new Set([...THRESHOLDS, threshold])].sort((a, b) => a - b).map((t) => (
                  <option key={t} value={t}>
                    +{t} %
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            onClick={() => onDismiss(unseen.map((a) => a.id))}
            className="text-[11px] font-semibold text-avocado-700 dark:text-avocado-400"
          >
            Marcar vistas
          </button>
        </div>
      </div>
      <ul className="space-y-1.5">
        {unseen.slice(0, 6).map((a) => (
          <li key={a.id} className="liquid-glass-subtle rounded-lg px-3 py-2 flex items-center gap-2">
            <p className="flex-1 min-w-0 text-xs">
              <strong>{a.productName}</strong> subió <strong className="text-rose-600 dark:text-rose-400">{a.changePct} %</strong> en{' '}
              {a.supermarket}{' '}
              <span className="text-[var(--text-muted)] tabular-nums">
                ({formatCurrency(a.previousPrice, currency)} → {formatCurrency(a.newPrice, currency)} por {a.unitLabel})
              </span>
            </p>
            <button
              onClick={() => onMute(a)}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--glass-bg-hover)] shrink-0"
              title="No avisar más de este producto"
              aria-label={`Silenciar alertas de ${a.productName}`}
            >
              <BellOff className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onDismiss([a.id])}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--glass-bg-hover)] shrink-0"
              aria-label="Marcar como vista"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Camera, ShoppingCart, Sun, X } from 'lucide-react';
import { buildLastPriceIndex, estimateListItemCost } from '../lib/priceHistory';
import { CurrencyCode, Household, Purchase, ShoppingListItem } from '../types/grocery';
import { formatCurrency, translateCategory } from '../utils/formatters';
import { getCurrentMonthPrefix } from '../utils/dates';

interface SupermarketModeProps {
  household: Household;
  currency: CurrencyCode;
  items: ShoppingListItem[];
  purchases: Purchase[];
  isOnline: boolean;
  onToggleItem: (id: string) => void;
  onOpenScanner: () => void;
  onClose: () => void;
}

type WakeLockSentinelLike = { release: () => Promise<void>; released?: boolean };

/** Keeps the screen on while the mode is open (Screen Wake Lock API; silently skipped when unsupported). */
function useWakeLock(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLockSentinelLike> } };
    if (!nav.wakeLock) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        sentinel = await nav.wakeLock!.request('screen');
        if (cancelled) void sentinel.release();
        else setActive(true);
      } catch {
        setActive(false);
      }
    };
    // The lock is dropped whenever the tab is hidden; take it again on return
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => undefined);
    };
  }, []);
  return active;
}

/** Big, one-handed view of the shopping list for use with the cart. */
export const SupermarketMode: React.FC<SupermarketModeProps> = ({
  household,
  currency,
  items,
  purchases,
  isOnline,
  onToggleItem,
  onOpenScanner,
  onClose,
}) => {
  const lang = household.language;
  const wakeLock = useWakeLock();
  const [confirmFinish, setConfirmFinish] = useState(false);
  // Items already checked before opening stay out of the way; ones checked here stay visible at the bottom
  const openedAtRef = useRef(new Date().toISOString());

  const priceIndex = useMemo(() => buildLastPriceIndex(purchases), [purchases]);
  const visible = items.filter((i) => !i.isChecked || (i.checkedAt && i.checkedAt >= openedAtRef.current));

  const aisleOrder = new Map(household.categories.map((c) => [c.name, c.aisleOrder]));
  const groups = new Map<string, ShoppingListItem[]>();
  for (const item of visible) {
    const list = groups.get(item.category) ?? [];
    list.push(item);
    groups.set(item.category, list);
  }
  const orderedGroups = [...groups.entries()]
    .map(([cat, list]) => [cat, [...list].sort((a, b) => Number(a.isChecked) - Number(b.isChecked) || a.name.localeCompare(b.name))] as const)
    // Groups that are fully done sink to the end
    .sort(([ca, la], [cb, lb]) => {
      const doneA = la.every((i) => i.isChecked);
      const doneB = lb.every((i) => i.isChecked);
      if (doneA !== doneB) return doneA ? 1 : -1;
      return (aisleOrder.get(ca as never) ?? 99) - (aisleOrder.get(cb as never) ?? 99);
    });

  const checkedHere = visible.filter((i) => i.isChecked);
  const pending = visible.filter((i) => !i.isChecked);
  const cartEstimate = checkedHere.reduce((sum, i) => sum + (estimateListItemCost(priceIndex, i) ?? 0), 0);
  const unknownPrices = checkedHere.filter((i) => estimateListItemCost(priceIndex, i) === null).length;

  const month = getCurrentMonthPrefix();
  const spentThisMonth = purchases.filter((p) => p.purchaseDate.startsWith(month)).reduce((s, p) => s + p.totalAmount, 0);
  const budget = household.monthlyBudget;
  const remaining = budget - spentThisMonth - cartEstimate;
  const tone =
    budget <= 0 ? 'neutral' : remaining < 0 ? 'red' : remaining < budget * 0.15 ? 'amber' : 'green';
  const toneClass = {
    neutral: 'bg-slate-500/10 text-[var(--text-primary)]',
    green: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200',
    amber: 'bg-amber-500/20 text-amber-900 dark:text-amber-200',
    red: 'bg-rose-500/20 text-rose-900 dark:text-rose-200',
  }[tone];

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      {/* Sticky top bar: cart estimate and what's left of the month's budget */}
      <div className="shrink-0 pt-[env(safe-area-inset-top)] border-b border-[var(--glass-border)] liquid-glass-elevated">
        <div className="flex items-center gap-2 px-3 pt-2">
          <ShoppingCart className="w-5 h-5 text-avocado-600" />
          <p className="text-base font-extrabold flex-1">Modo súper</p>
          {wakeLock && (
            <span className="text-[11px] font-semibold text-[var(--text-muted)] flex items-center gap-1">
              <Sun className="w-3.5 h-3.5" /> Pantalla encendida
            </span>
          )}
          {!isOnline && (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300">
              Sin señal
            </span>
          )}
          <button
            onClick={onClose}
            className="w-11 h-11 rounded-xl liquid-glass-subtle liquid-glass-interactive flex items-center justify-center"
            aria-label="Salir del modo súper"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 p-3">
          <div className="rounded-xl liquid-glass-subtle px-3 py-2">
            <p className="text-[11px] font-semibold text-[var(--text-muted)]">En el carrito (aprox.)</p>
            <p className="text-xl font-extrabold tabular-nums">{formatCurrency(cartEstimate, currency)}</p>
            {unknownPrices > 0 && (
              <p className="text-[10px] text-[var(--text-muted)]">
                {unknownPrices} sin precio conocido
              </p>
            )}
          </div>
          <div className={`rounded-xl px-3 py-2 ${toneClass}`}>
            <p className="text-[11px] font-semibold opacity-80">Queda del presupuesto</p>
            <p className="text-xl font-extrabold tabular-nums">{budget > 0 ? formatCurrency(remaining, currency) : '—'}</p>
            <p className="text-[10px] opacity-80">
              {checkedHere.length} en el carrito · {pending.length} por buscar
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {visible.length === 0 && (
          <p className="py-16 text-center text-base text-[var(--text-muted)]">La lista está vacía.</p>
        )}
        {orderedGroups.map(([category, list]) => (
          <section key={category} className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
              {translateCategory(category as ShoppingListItem['category'], lang)}
            </h3>
            {list.map((item) => {
              const estimate = estimateListItemCost(priceIndex, item);
              return (
                <button
                  key={item.id}
                  onClick={() => onToggleItem(item.id)}
                  aria-pressed={item.isChecked}
                  className={`w-full min-h-[64px] rounded-2xl px-4 py-3 flex items-center gap-4 text-left transition active:scale-[0.99] ${
                    item.isChecked ? 'liquid-glass-subtle opacity-55' : 'liquid-glass'
                  }`}
                >
                  <span
                    className={`w-9 h-9 rounded-xl border-[3px] flex items-center justify-center shrink-0 ${
                      item.isChecked ? 'bg-avocado-600 border-avocado-600 text-white' : 'border-slate-300 dark:border-slate-500'
                    }`}
                  >
                    {item.isChecked && <Check className="w-6 h-6" strokeWidth={3} />}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className={`block text-lg font-bold leading-tight ${item.isChecked ? 'line-through' : ''}`}>{item.name}</span>
                    <span className="block text-sm text-[var(--text-muted)]">
                      {item.quantity} {item.unit}
                      {item.store ? ` · ${item.store}` : ''}
                    </span>
                  </span>
                  {estimate !== null && (
                    <span className="text-sm font-semibold tabular-nums text-[var(--text-secondary)] shrink-0">
                      {formatCurrency(estimate, currency)}
                    </span>
                  )}
                </button>
              );
            })}
          </section>
        ))}
      </div>

      <div className="shrink-0 p-3 pb-[calc(env(safe-area-inset-bottom)+12px)] border-t border-[var(--glass-border)] liquid-glass-elevated">
        {confirmFinish ? (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-center">¿Registramos la compra?</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  onClose();
                  onOpenScanner();
                }}
                className="min-h-[52px] rounded-xl liquid-lens-btn text-sm font-bold flex items-center justify-center gap-2"
              >
                <Camera className="w-5 h-5" /> Escanear o registrar
              </button>
              <button
                onClick={onClose}
                className="min-h-[52px] rounded-xl liquid-glass-subtle liquid-glass-interactive text-sm font-bold"
              >
                Más tarde
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmFinish(true)}
            className="w-full min-h-[56px] rounded-2xl liquid-lens-btn text-base font-extrabold"
          >
            Terminar compra
          </button>
        )}
      </div>
    </div>
  );
};

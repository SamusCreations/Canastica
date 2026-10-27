import React, { useState } from 'react';
import {
  AlertTriangle,
  Award,
  BarChart3,
  Calendar,
  Download,
  MapPin,
  Plus,
  Store,
  Trash2,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react';
import {
  Household,
  Purchase,
  SupermarketStore,
  SupermarketType,
} from '../types/grocery';
import { exportPurchasesToCsv } from '../utils/exportCsv';
import { formatCurrency } from '../utils/formatters';
import { addDaysIso, getMonthPrefix, getTodayIso, monthLabel, monthName } from '../utils/dates';
import { Avatar } from './Avatar';

interface AnalyticsAndPricesViewProps {
  household: Household;
  purchases: Purchase[];
  onCreateSupermarket: (store: Omit<SupermarketStore, 'id'>) => void;
  onDeleteSupermarket: (id: string) => void;
}

export const AnalyticsAndPricesView: React.FC<AnalyticsAndPricesViewProps> = ({
  household,
  purchases,
  onCreateSupermarket,
  onDeleteSupermarket,
}) => {
  const [subTab, setSubTab] = useState<'overview' | 'comparator' | 'stores'>('overview');
  const [timeframe, setTimeframe] = useState<'weekly' | 'monthly' | 'yearly'>('monthly');
  const [selectedProduct, setSelectedProduct] = useState<string>('Pechuga de Pollo');
  const [exportStart, setExportStart] = useState(`${getMonthPrefix(-2)}-01`);
  const [exportEnd, setExportEnd] = useState(getTodayIso());
  const [exportToast, setExportToast] = useState<string | null>(null);

  // Custom supermarket form state
  const [newStoreName, setNewStoreName] = useState('');
  const [newStoreType, setNewStoreType] = useState<SupermarketType>('Abastecedor / Pulpería');
  const [newStoreLocation, setNewStoreLocation] = useState('');

  const cur = household.currency;

  const filteredPurchases = purchases.filter(
    (p) => p.purchaseDate >= exportStart && p.purchaseDate <= exportEnd
  );

  const totalPeriodSpent = filteredPurchases.reduce((sum, p) => sum + p.totalAmount, 0);

  // Real spend per bucket (last 4 weeks / months / quarters) from saved purchases
  const today = getTodayIso();
  const sumBetween = (from: string, to: string) =>
    purchases
      .filter((p) => p.purchaseDate >= from && p.purchaseDate <= to)
      .reduce((sum, p) => sum + p.totalAmount, 0);
  const weeklyBudget = Math.round((household.monthlyBudget * 12) / 52);

  const chartPoints =
    timeframe === 'weekly'
      ? [3, 2, 1, 0].map((weeksAgo) => {
          const to = addDaysIso(today, -7 * weeksAgo);
          const from = addDaysIso(to, -6);
          return {
            label: weeksAgo === 0 ? 'Esta sem.' : `Hace ${weeksAgo} sem.`,
            spent: sumBetween(from, to),
            budget: weeklyBudget,
          };
        })
      : timeframe === 'monthly'
      ? [-3, -2, -1, 0].map((offset) => {
          const prefix = getMonthPrefix(offset);
          return {
            label: monthLabel(prefix, household.language, true),
            spent: sumBetween(`${prefix}-01`, `${prefix}-31`),
            budget: household.monthlyBudget,
          };
        })
      : [-9, -6, -3, 0].map((offset) => {
          const lastPrefix = getMonthPrefix(offset);
          const firstPrefix = getMonthPrefix(offset - 2);
          return {
            label: `${monthName(firstPrefix, household.language, true)}–${monthName(lastPrefix, household.language, true)}`,
            spent: sumBetween(`${firstPrefix}-01`, `${lastPrefix}-31`),
            budget: household.monthlyBudget * 3,
          };
        });

  const maxChartVal = Math.max(
    ...chartPoints.map((c) => Math.max(c.spent, c.budget)),
    10000
  );

  const storeTotals = new Map<string, number>();
  for (const p of filteredPurchases) {
    storeTotals.set(p.supermarket, (storeTotals.get(p.supermarket) || 0) + p.totalAmount);
  }
  const storeDistribution = Array.from(storeTotals.entries())
    .map(([store, amount]) => ({
      store,
      amount,
      pct: Math.round((amount / Math.max(1, totalPeriodSpent)) * 100),
    }))
    .sort((a, b) => b.amount - a.amount);

  const memberTotals = new Map<string, number>();
  for (const p of filteredPurchases) {
    memberTotals.set(p.createdBy, (memberTotals.get(p.createdBy) || 0) + p.totalAmount);
  }

  // Products bought at least twice, most frequent first (max 8)
  const productCounts = new Map<string, number>();
  purchases
    .flatMap((p) => p.items)
    .forEach((i) => productCounts.set(i.canonicalName, (productCounts.get(i.canonicalName) || 0) + 1));
  const productCatalog = Array.from(productCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 8)
    .map(([name]) => name);

  interface ProductPriceCompareRow {
    canonicalName: string;
    standardUnitLabel: string;
    storePrices: { store: string; date: string; normUnitPrice: number }[];
    cheapestStore: string;
    cheapestPrice: number;
    highestStore: string;
    highestPrice: number;
    potentialSavingsPct: number;
    hasPriceSpikeAlert: boolean;
    spikeMessage?: string;
  }

  const priceComparisons: ProductPriceCompareRow[] = productCatalog.map((canonical) => {
    const matchingItems = purchases
      .flatMap((p) => p.items)
      .filter((i) => i.canonicalName === canonical)
      .sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));

    let standardUnitLabel = 'por 1 L / 1 kg';
    const points = matchingItems.map((it) => {
      let normPrice = it.unitPrice;
      if (it.baseUnit === 'ml') {
        standardUnitLabel = 'por 1 L (1,000 ml)';
        normPrice = (it.totalPrice / Math.max(1, it.baseUnitQuantity)) * 1000;
      } else if (it.baseUnit === 'g') {
        standardUnitLabel = 'por 1 kg (1,000 g)';
        normPrice = (it.totalPrice / Math.max(1, it.baseUnitQuantity)) * 1000;
      } else {
        standardUnitLabel = 'por 12 unid';
        normPrice = (it.totalPrice / Math.max(1, it.baseUnitQuantity)) * 12;
      }
      return {
        store: it.supermarket,
        date: it.purchaseDate,
        normUnitPrice: Math.round(normPrice),
      };
    });

    const sortedByPrice = [...points].sort((a, b) => a.normUnitPrice - b.normUnitPrice);
    const cheapest = sortedByPrice[0] || { store: '—', normUnitPrice: 0 };
    const highest = sortedByPrice[sortedByPrice.length - 1] || cheapest;
    const savingsPct =
      highest.normUnitPrice > 0
        ? Math.round(
            ((highest.normUnitPrice - cheapest.normUnitPrice) / highest.normUnitPrice) * 100
          )
        : 0;

    const firstPrice = points[0]?.normUnitPrice || 0;
    const latestPrice = points[points.length - 1]?.normUnitPrice || 0;
    const spikePct =
      firstPrice > 0 ? Math.round(((latestPrice - firstPrice) / firstPrice) * 100) : 0;

    return {
      canonicalName: canonical,
      standardUnitLabel,
      storePrices: points,
      cheapestStore: cheapest.store,
      cheapestPrice: cheapest.normUnitPrice,
      highestStore: highest.store,
      highestPrice: highest.normUnitPrice,
      potentialSavingsPct: savingsPct,
      hasPriceSpikeAlert: spikePct >= 9 || savingsPct >= 14,
      spikeMessage:
        spikePct >= 9
          ? `El último precio (${formatCurrency(latestPrice, cur)}) subió +${spikePct}% frente a compras previas (${formatCurrency(firstPrice, cur)})`
          : savingsPct >= 14
          ? `${highest.store} es un ${savingsPct}% más caro que ${cheapest.store}`
          : undefined,
    };
  });

  const activeProductComparison =
    priceComparisons.find((p) => p.canonicalName === selectedProduct) || priceComparisons[0];

  const handleExportCsv = () => {
    const count = exportPurchasesToCsv(
      purchases,
      household.members,
      exportStart,
      exportEnd
    );
    setExportToast(`¡Se exportaron ${count} líneas de compra a CSV compatible con Excel!`);
    setTimeout(() => setExportToast(null), 3000);
  };

  const handleAddStoreSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newStoreName.trim();
    if (!trimmed) return;
    onCreateSupermarket({
      name: trimmed,
      type: newStoreType,
      color: '#4f7f27',
      locationHint: newStoreLocation.trim() || 'Comercio Registrado',
      isCustom: true,
    });
    setNewStoreName('');
    setNewStoreLocation('');
  };

  return (
    <div className="space-y-3.5">
      {/* Unified Minimalist Sub-Navigation & Date/Export Bar */}
      <div className="liquid-glass rounded-xl p-3 flex flex-wrap items-center justify-between gap-2.5">
        {/* Segmented Sub-View Switcher (Eliminates vertical stacking & scrollbars!) */}
        <div className="liquid-glass-subtle rounded-lg p-1 flex flex-wrap items-center gap-1">
          <button
            onClick={() => setSubTab('overview')}
            className={`px-3 py-1.5 rounded-md text-xs font-bold flex items-center gap-1.5 transition ${
              subTab === 'overview'
                ? 'liquid-lens-btn text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            Gasto y Distribución
          </button>
          <button
            onClick={() => setSubTab('comparator')}
            className={`px-3 py-1.5 rounded-md text-xs font-bold flex items-center gap-1.5 transition ${
              subTab === 'comparator'
                ? 'liquid-lens-btn text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <TrendingDown className="w-3.5 h-3.5" />
            Comparador de Precios
          </button>
          <button
            onClick={() => setSubTab('stores')}
            className={`px-3 py-1.5 rounded-md text-xs font-bold flex items-center gap-1.5 transition ${
              subTab === 'stores'
                ? 'liquid-lens-btn text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Store className="w-3.5 h-3.5" />
            Supermercados ({household.supermarkets.length})
          </button>
        </div>

        {/* Date Filter & CSV/Excel Export Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-auto liquid-glass-subtle rounded-lg px-2.5 py-1 grid grid-cols-[auto_1fr_auto_1fr] items-center gap-1.5 text-[11px]">
            <Calendar className="w-3.5 h-3.5 text-avocado-600 dark:text-avocado-400" />
            <input
              type="date"
              aria-label="Desde"
              value={exportStart}
              onChange={(e) => setExportStart(e.target.value)}
              className="min-w-0 w-full bg-transparent font-semibold focus:outline-none"
            />
            <span className="text-[var(--text-muted)]">a</span>
            <input
              type="date"
              aria-label="Hasta"
              value={exportEnd}
              onChange={(e) => setExportEnd(e.target.value)}
              className="min-w-0 w-full bg-transparent font-semibold focus:outline-none"
            />
          </div>

          <button
            onClick={handleExportCsv}
            className="liquid-lens-btn px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            Exportar CSV
          </button>
        </div>
      </div>

      {exportToast && (
        <div className="liquid-glass rounded-xl px-3.5 py-2 border border-emerald-500/45 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs font-bold animate-spring-in">
          ✓ {exportToast}
        </div>
      )}

      {/* ====================================================================
          SUB-VIEW 1: Gasto y Distribución (Fits 100% in viewport)
          ==================================================================== */}
      {subTab === 'overview' && (
        <div className="space-y-3.5 animate-spring-in">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
            {/* Spending vs Budget Chart (7 cols) */}
            <div className="lg:col-span-7 liquid-glass rounded-xl p-4 flex flex-col justify-between space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold">Gasto frente al Presupuesto del Hogar</h3>
                  <p className="text-xs text-[var(--text-muted)]">
                    Total en el periodo:{' '}
                    <strong className="text-[var(--text-primary)]">
                      {formatCurrency(totalPeriodSpent, cur)}
                    </strong>{' '}
                    ({filteredPurchases.length} facturas)
                  </p>
                </div>

                <div className="liquid-glass-subtle rounded-lg p-1 flex items-center gap-1">
                  {(
                    [
                      { id: 'weekly', label: 'Semanal' },
                      { id: 'monthly', label: 'Mensual' },
                      { id: 'yearly', label: 'Anual' },
                    ] as const
                  ).map((tf) => (
                    <button
                      key={tf.id}
                      onClick={() => setTimeframe(tf.id)}
                      className={`px-2.5 py-1 rounded-md text-xs font-bold transition ${
                        timeframe === tf.id
                          ? 'liquid-lens-btn text-white'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {tf.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Interactive Column & Budget Threshold Chart */}
              <div className="grid grid-cols-4 gap-4 items-end h-56 pt-4 px-2">
                {chartPoints.map((pt) => {
                  const spentHeightPct = Math.max(12, Math.round((pt.spent / maxChartVal) * 100));
                  const budgetHeightPct = Math.max(12, Math.round((pt.budget / maxChartVal) * 100));

                  return (
                    <div
                      key={pt.label}
                      className="flex flex-col items-center gap-2 h-full justify-end"
                    >
                      <div className="text-center">
                        <span className="text-xs font-extrabold block text-avocado-600 dark:text-avocado-400">
                          {formatCurrency(pt.spent, cur, true)}
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)] block">
                          Meta: {formatCurrency(pt.budget, cur, true)}
                        </span>
                      </div>
                      <div className="w-full max-w-[64px] h-40 liquid-glass-subtle rounded-xl relative flex items-end p-1.5">
                        <div
                          className="absolute left-0 right-0 border-t-2 border-dashed border-amber-500/80 z-10"
                          style={{ bottom: `${budgetHeightPct}%` }}
                          title={`Meta: ${formatCurrency(pt.budget, cur)}`}
                        />
                        <div
                          className="w-full rounded-lg transition-all duration-700 bg-avocado-600"
                          style={{ height: `${spentHeightPct}%` }}
                        />
                      </div>
                      <span className="text-xs font-semibold text-[var(--text-secondary)]">
                        {pt.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Supermarket & Member Distribution (5 cols) */}
            <div className="lg:col-span-5 liquid-glass rounded-xl p-4 flex flex-col justify-between space-y-4">
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
                    <Store className="w-3.5 h-3.5 text-avocado-600 dark:text-avocado-400" />
                    Gasto por Supermercado
                  </h3>
                  <button
                    onClick={() => setSubTab('stores')}
                    className="text-[11px] font-bold text-avocado-600 dark:text-avocado-400 hover:underline"
                  >
                    + Gestionar Comercios
                  </button>
                </div>
                <div className="space-y-2">
                  {storeDistribution.map((st) => (
                    <div key={st.store} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="font-semibold">{st.store}</span>
                        <span className="font-mono">
                          <strong>{formatCurrency(st.amount, cur)}</strong> ({st.pct}%)
                        </span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-avocado-600"
                          style={{ width: `${st.pct}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2.5 pt-3 border-t border-[var(--glass-border)]">
                <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                  Pagado por Miembro
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {household.members.map((m) => {
                    const paid = memberTotals.get(m.id) || 0;
                    return (
                      <div
                        key={m.id}
                        className="liquid-glass-subtle rounded-lg p-2 flex items-center gap-2"
                      >
                        <Avatar name={m.name} src={m.avatarUrl} color={m.accentColor} className="w-7 h-7" />
                        <div className="min-w-0">
                          <span className="text-xs font-bold block truncate">{m.name}</span>
                          <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400 font-bold">
                            {formatCurrency(paid, cur)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Summary Strip: Quick Price Highlights */}
          <div className="liquid-glass rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Award className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span className="text-xs font-bold">
                Oportunidades de Ahorro por Supermercado:
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {priceComparisons.slice(0, 4).map((row) => (
                <button
                  key={row.canonicalName}
                  onClick={() => {
                    setSelectedProduct(row.canonicalName);
                    setSubTab('comparator');
                  }}
                  className="liquid-glass-subtle liquid-glass-interactive rounded-lg px-2.5 py-1 text-xs flex items-center gap-1.5"
                >
                  <span className="font-bold">{row.canonicalName}:</span>
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold">
                    {row.cheapestStore} (−{row.potentialSavingsPct}%)
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          SUB-VIEW 2: Comparador de Precios e Historial (Fits 100% in viewport)
          ==================================================================== */}
      {subTab === 'comparator' && !activeProductComparison && (
        <div className="liquid-glass rounded-xl p-6 text-center space-y-1.5 animate-spring-in">
          <TrendingUp className="w-6 h-6 mx-auto text-avocado-600 dark:text-avocado-400" />
          <p className="text-sm font-bold">Aún no hay suficientes compras para comparar precios</p>
          <p className="text-xs text-[var(--text-muted)]">
            Cuando compres el mismo producto al menos dos veces, verás aquí su historial de precio y
            en qué supermercado sale más barato.
          </p>
        </div>
      )}

      {subTab === 'comparator' && activeProductComparison && (
        <div className="space-y-3.5 animate-spring-in">
          {/* Product Price History Trajectory & Price Alerts */}
          <div className="liquid-glass rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-avocado-600 dark:text-avocado-400" />
                <h3 className="text-xs font-bold uppercase tracking-wider">
                  Evolución de Precio por Producto ({activeProductComparison.standardUnitLabel})
                </h3>
              </div>

              {/* Product Selector Pills */}
              <div className="flex flex-wrap gap-1">
                {productCatalog.map((prod) => (
                  <button
                    key={prod}
                    onClick={() => setSelectedProduct(prod)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition ${
                      activeProductComparison.canonicalName === prod
                        ? 'liquid-lens-btn text-white'
                        : 'liquid-glass-subtle liquid-glass-interactive'
                    }`}
                  >
                    {prod}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 items-center">
              <div className="lg:col-span-8 liquid-glass-subtle rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-avocado-600 dark:text-avocado-400">
                    {activeProductComparison.canonicalName} — Historial Normalizado
                  </span>
                  {activeProductComparison.hasPriceSpikeAlert && (
                    <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[10px] font-bold flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> Variación Detectada
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {activeProductComparison.storePrices.map((pt, idx) => (
                    <div
                      key={`${pt.date}-${idx}`}
                      className="liquid-glass rounded-lg p-2.5 flex flex-col justify-between"
                    >
                      <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                        <span>{pt.date}</span>
                        <span className="font-bold text-avocado-600 dark:text-avocado-400 truncate ml-1">
                          {pt.store}
                        </span>
                      </div>
                      <div className="text-sm font-extrabold font-mono mt-1">
                        {formatCurrency(pt.normUnitPrice, cur)}
                      </div>
                      <span className="text-[9px] text-[var(--text-muted)]">
                        {activeProductComparison.standardUnitLabel}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="lg:col-span-4 liquid-glass rounded-xl p-3.5 space-y-1.5 border border-emerald-500/35 bg-emerald-500/5">
                <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300 font-bold text-[11px] uppercase tracking-wider">
                  <Award className="w-3.5 h-3.5" /> Más Económico
                </div>
                <div className="text-base font-extrabold text-emerald-600 dark:text-emerald-400">
                  {activeProductComparison.cheapestStore} (
                  {formatCurrency(activeProductComparison.cheapestPrice, cur)})
                </div>
                <p className="text-[11px] text-[var(--text-secondary)]">
                  Ahorras un <strong>{activeProductComparison.potentialSavingsPct}%</strong> (
                  {formatCurrency(
                    activeProductComparison.highestPrice - activeProductComparison.cheapestPrice,
                    cur
                  )}
                  ) vs. {activeProductComparison.highestStore}.
                </p>
                {activeProductComparison.spikeMessage && (
                  <div className="p-2 rounded-lg bg-amber-500/15 text-[10px] text-amber-800 dark:text-amber-200 font-medium">
                    ⚠️ {activeProductComparison.spikeMessage}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Full Supermarket Comparator Table */}
          <div className="liquid-glass rounded-xl p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
                <TrendingDown className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                Matriz Comparadora de Supermercados
              </h3>
              <span className="text-[11px] text-[var(--text-muted)]">
                Precios normalizados a 1 L, 1 kg o 12 unidades
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[var(--glass-border)] text-[var(--text-muted)]">
                    <th className="py-2 pr-3">Producto</th>
                    <th className="py-2 pr-3">Unidad Base</th>
                    <th className="py-2 pr-3">Más Barato En</th>
                    <th className="py-2 pr-3">Más Caro En</th>
                    <th className="py-2">Ahorro Potencial</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--glass-border)]">
                  {priceComparisons.map((row) => (
                    <tr
                      key={row.canonicalName}
                      onClick={() => setSelectedProduct(row.canonicalName)}
                      className="cursor-pointer hover:bg-[var(--glass-bg-hover)] transition"
                    >
                      <td className="py-2 pr-3 font-bold">{row.canonicalName}</td>
                      <td className="py-2 pr-3 text-[11px] text-[var(--text-muted)]">
                        {row.standardUnitLabel}
                      </td>
                      <td className="py-2 pr-3">
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-bold text-[11px]">
                          {row.cheapestStore} • {formatCurrency(row.cheapestPrice, cur)}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-[var(--text-secondary)]">
                        {row.highestStore} • {formatCurrency(row.highestPrice, cur)}
                      </td>
                      <td className="py-2 font-mono font-bold text-avocado-600 dark:text-avocado-400">
                        −{row.potentialSavingsPct}% (
                        {formatCurrency(row.highestPrice - row.cheapestPrice, cur)})
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          SUB-VIEW 3: Directorio de Supermercados y Creación de Comercios
          ==================================================================== */}
      {subTab === 'stores' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 animate-spring-in">
          {/* Left: Create Custom Supermarket Form (4 cols) */}
          <div className="lg:col-span-4 liquid-glass rounded-xl p-4 space-y-3.5 h-fit">
            <div>
              <h3 className="text-sm font-bold flex items-center gap-2">
                <Plus className="w-4 h-4 text-avocado-600 dark:text-avocado-400" />
                Registrar Nuevo Supermercado
              </h3>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Añade pulperías, abastecedores de barrio, ferias del agricultor o carnicerías locales
              </p>
            </div>

            <form onSubmit={handleAddStoreSubmit} className="space-y-2.5">
              <div>
                <label className="text-[11px] font-semibold text-[var(--text-secondary)] block mb-1">
                  Nombre del Comercio
                </label>
                <input
                  type="text"
                  value={newStoreName}
                  onChange={(e) => setNewStoreName(e.target.value)}
                  placeholder="Ej. Abastecedor La Amistad"
                  className="liquid-input w-full px-3 py-2 rounded-lg text-xs"
                />
              </div>

              <div>
                <label className="text-[11px] font-semibold text-[var(--text-secondary)] block mb-1">
                  Tipo de Establecimiento
                </label>
                <select
                  value={newStoreType}
                  onChange={(e) => setNewStoreType(e.target.value as SupermarketType)}
                  className="liquid-input w-full px-3 py-2 rounded-lg text-xs"
                >
                  <option value="Abastecedor / Pulpería">Abastecedor / Pulpería</option>
                  <option value="Feria del Agricultor">Feria del Agricultor</option>
                  <option value="Carnicería / Especialidad">Carnicería / Especialidad</option>
                  <option value="Cadena Nacional">Cadena Nacional</option>
                  <option value="Club Mayorista">Club Mayorista</option>
                  <option value="Otro">Otro Comercio</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-[var(--text-secondary)] block mb-1">
                  Ubicación / Barrio (Opcional)
                </label>
                <input
                  type="text"
                  value={newStoreLocation}
                  onChange={(e) => setNewStoreLocation(e.target.value)}
                  placeholder="Ej. San Pedro, Montes de Oca"
                  className="liquid-input w-full px-3 py-2 rounded-lg text-xs"
                />
              </div>

              <button
                type="submit"
                disabled={!newStoreName.trim()}
                className="w-full liquid-lens-btn py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40"
              >
                <Plus className="w-3.5 h-3.5" /> Guardar Supermercado
              </button>
            </form>
          </div>

          {/* Right: Full Grid of Registered Supermarkets (8 cols, Zero Nested Scrollbar!) */}
          <div className="lg:col-span-8 liquid-glass rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold flex items-center gap-2">
                <Store className="w-4 h-4 text-avocado-600 dark:text-avocado-400" />
                Comercios Activos en {household.name} ({household.supermarkets.length})
              </h3>
              <span className="text-[11px] text-[var(--text-muted)]">
                Disponibles al escanear facturas
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {household.supermarkets.map((st) => (
                <div
                  key={st.id}
                  className="liquid-glass-subtle rounded-xl p-3 flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: st.color }}
                      />
                      <span className="font-bold truncate">{st.name}</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-500/10 text-[var(--text-secondary)] shrink-0">
                        {st.type}
                      </span>
                    </div>
                    {st.locationHint && (
                      <p className="text-[11px] text-[var(--text-muted)] flex items-center gap-1 mt-1 truncate">
                        <MapPin className="w-3 h-3 shrink-0" /> {st.locationHint}
                      </p>
                    )}
                  </div>
                  {st.isCustom && (
                    <button
                      onClick={() => onDeleteSupermarket(st.id)}
                      className="p-1.5 rounded-lg hover:bg-rose-500/15 text-rose-500 transition shrink-0"
                      title="Eliminar comercio personalizado"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

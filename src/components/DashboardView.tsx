import React, { useState } from 'react';
import { receiptFileKind } from '../utils/receiptFile';
import {
  AlertCircle,
  ArrowUpRight,
  Camera,
  Check,
  ListChecks,
  Plus,
  Receipt,
  ScanLine,
  ShoppingCart,
  Sparkles,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { generateHouseholdAIInsights } from '../services/geminiAndSupabaseService';
import {
  GroceryCategory,
  Household,
  Purchase,
  RestockPrediction,
} from '../types/grocery';
import {
  formatCurrency,
  translateCategory,
  translateConfidence,
} from '../utils/formatters';
import { getCurrentMonthPrefix, monthName, monthProgress } from '../utils/dates';

interface DashboardViewProps {
  household: Household;
  purchases: Purchase[];
  predictions: RestockPrediction[];
  onQuickAddShoppingItem: (item: {
    name: string;
    canonicalName: string;
    category: GroceryCategory;
    quantity: number;
    unit: string;
  }) => void;
  onRestockFeedback: (canonicalName: string, feedback: 'ran_out' | 'still_have_some') => void;
  onInspectPurchase: (purchase: Purchase) => void;
  onOpenScanner: () => void;
  onNavigateTab: (tab: string) => void;
  onOpenAssistantWithPrompt: (prompt: string) => void;
  onOpenSupermarketMode: () => void;
  pendingListCount: number;
  priceAlertCount: number;
}

const FREQUENT_QUICK_CHIPS: {
  name: string;
  canonicalName: string;
  category: GroceryCategory;
  quantity: number;
  unit: string;
}[] = [
  { name: 'Leche Dos Pinos 1L', canonicalName: 'Leche', category: 'Dairy & Eggs', quantity: 2, unit: 'L' },
  { name: 'Huevos de Granja 12u', canonicalName: 'Huevos', category: 'Dairy & Eggs', quantity: 12, unit: 'unid' },
  { name: 'Pechuga de Pollo', canonicalName: 'Pechuga de Pollo', category: 'Meat & Poultry', quantity: 1.5, unit: 'kg' },
  { name: 'Aguacate Hass', canonicalName: 'Aguacate Hass', category: 'Produce', quantity: 1, unit: 'kg' },
  { name: 'Pan Integral Artesanal', canonicalName: 'Pan Integral', category: 'Bakery', quantity: 1, unit: 'bolsa' },
  { name: 'Café Molido 500g', canonicalName: 'Café en Grano / Molido', category: 'Beverages', quantity: 500, unit: 'g' },
  { name: 'Yogurt Griego 1kg', canonicalName: 'Yogurt Griego', category: 'Dairy & Eggs', quantity: 1, unit: 'kg' },
  { name: 'Detergente Líquido', canonicalName: 'Detergente Líquido', category: 'Cleaning & Home', quantity: 2, unit: 'L' },
];

export const DashboardView: React.FC<DashboardViewProps> = ({
  household,
  purchases,
  predictions,
  onQuickAddShoppingItem,
  onRestockFeedback,
  onInspectPurchase,
  onOpenScanner,
  onNavigateTab,
  onOpenAssistantWithPrompt,
  onOpenSupermarketMode,
  pendingListCount,
  priceAlertCount,
}) => {
  const [recentlyAddedChip, setRecentlyAddedChip] = useState<string | null>(null);
  const cur = household.currency;
  const lang = household.language;

  const monthPrefix = getCurrentMonthPrefix();
  const { daysInMonth, dayOfMonth } = monthProgress(monthPrefix);
  const daysLeftInMonth = Math.max(1, daysInMonth - dayOfMonth + 1);
  const currentMonthPurchases = purchases.filter((p) =>
    p.purchaseDate.startsWith(monthPrefix)
  );
  const currentMonthSpent = currentMonthPurchases.reduce(
    (sum, p) => sum + p.totalAmount,
    0
  );
  const budgetRemaining = Math.max(0, household.monthlyBudget - currentMonthSpent);
  const budgetPercentage = Math.min(
    100,
    Math.round((currentMonthSpent / Math.max(1, household.monthlyBudget)) * 100)
  );

  const categoryTotals = new Map<GroceryCategory, number>();
  for (const p of currentMonthPurchases) {
    for (const item of p.items) {
      categoryTotals.set(
        item.category,
        (categoryTotals.get(item.category) || 0) + item.totalPrice
      );
    }
  }

  const categoryRows = household.categories
    .map((cat) => {
      const spent = categoryTotals.get(cat.name) || 0;
      const pct = Math.min(
        100,
        Math.round((spent / Math.max(1, cat.monthlyAllocation)) * 100)
      );
      return {
        ...cat,
        spent,
        pct,
      };
    })
    .sort((a, b) => b.spent - a.spent);

  const insights = generateHouseholdAIInsights(purchases, household, predictions);
  const runningLowItems = predictions.slice(0, 4);

  const handleChipTap = (chip: (typeof FREQUENT_QUICK_CHIPS)[0]) => {
    onQuickAddShoppingItem(chip);
    setRecentlyAddedChip(chip.canonicalName);
    setTimeout(() => setRecentlyAddedChip(null), 1300);
  };

  const recent = purchases.slice(0, 5);
  const urgentCount = predictions.filter((p) => p.estimatedDaysRemaining <= household.restockAlertDays).length;
  const kpis = [
    { value: String(pendingListCount), label: lang === 'es' ? 'en la lista' : 'on the list', icon: ListChecks, tab: 'shopping-list' },
    { value: String(urgentCount), label: lang === 'es' ? 'por reponer' : 'to restock', icon: Sparkles, tab: 'restock-ai' },
    { value: String(priceAlertCount), label: lang === 'es' ? 'alertas de precio' : 'price alerts', icon: TrendingUp, tab: 'analytics' },
    {
      value: String(currentMonthPurchases.length),
      label: lang === 'es' ? 'compras este mes' : 'purchases this month',
      icon: Receipt,
      tab: 'analytics',
    },
  ];
  const daysLabel = (days: number) =>
    days <= 0
      ? lang === 'es'
        ? 'hoy'
        : 'today'
      : days === 1
        ? lang === 'es'
          ? 'mañana'
          : 'tomorrow'
        : lang === 'es'
          ? `en ${days} días`
          : `in ${days} days`;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 lg:gap-6">
      {/* Budget hero */}
      <section className="xl:col-span-2 relative overflow-hidden rounded-3xl bg-avocado-600 dark:bg-avocado-700 text-white p-5 sm:p-7">
        <div
          className="pointer-events-none absolute -right-12 -top-12 w-52 h-52 rounded-full border-[26px] border-white/10"
          aria-hidden="true"
        />
        <p className="text-sm text-avocado-100 font-medium">
          {lang === 'es' ? 'Gastado en' : 'Spent in'} {monthName(monthPrefix, lang).toLowerCase()}
        </p>
        <p className="text-4xl sm:text-5xl font-bold tracking-tight mt-1 tabular-nums">{formatCurrency(currentMonthSpent, cur)}</p>
        <p className="text-sm text-avocado-100 mt-1">
          {lang === 'es' ? 'de' : 'of'} {formatCurrency(household.monthlyBudget, cur)} · {lang === 'es' ? 'quedan' : 'left'}{' '}
          <strong className="text-white">{formatCurrency(budgetRemaining, cur)}</strong>
        </p>
        <div
          className="h-2 rounded-full bg-white/20 mt-4 overflow-hidden"
          role="progressbar"
          aria-valuenow={budgetPercentage}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`h-full rounded-full transition-all duration-700 ${budgetPercentage >= 90 ? 'bg-coral-400' : 'bg-white'}`}
            style={{ width: `${budgetPercentage}%` }}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 mt-5">
          <div className="flex gap-2">
            <button
              onClick={onOpenScanner}
              className="h-11 px-4 rounded-xl bg-white text-avocado-800 text-sm font-semibold flex items-center gap-2 whitespace-nowrap hover:bg-avocado-50 transition"
            >
              <ScanLine className="w-4 h-4" /> {lang === 'es' ? 'Escanear' : 'Scan'}
            </button>
            <button
              onClick={onOpenSupermarketMode}
              className="h-11 px-4 rounded-xl bg-white/15 hover:bg-white/25 text-sm font-semibold flex items-center gap-2 whitespace-nowrap transition"
            >
              <ShoppingCart className="w-4 h-4" /> {lang === 'es' ? 'Modo súper' : 'Store mode'}
            </button>
          </div>
          <p className="text-sm text-avocado-100">
            {lang === 'es' ? 'Puedes gastar' : 'You can spend'}{' '}
            <strong className="text-white tabular-nums">{formatCurrency(budgetRemaining / daysLeftInMonth, cur, true)}</strong>{' '}
            {lang === 'es' ? 'por día' : 'per day'}
          </p>
        </div>
      </section>

      {/* Smart insight */}
      <section className="card p-5 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-bold flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-avocado-600 dark:text-avocado-400" />
            {lang === 'es' ? 'Resumen del mes' : 'Monthly insight'}
          </h3>
          <button
            onClick={() =>
              onOpenAssistantWithPrompt(
                `¿Cuánto hemos gastado en ${monthName(monthPrefix, 'es').toLowerCase()} por categoría y dónde podemos ahorrar?`
              )
            }
            className="text-sm font-semibold text-avocado-700 dark:text-avocado-300 flex items-center gap-1 min-h-9"
          >
            {lang === 'es' ? 'Preguntar' : 'Ask'} <ArrowUpRight className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[15px] leading-snug">{insights.headline}</p>
        <p className="text-sm text-[var(--text-secondary)] rounded-xl bg-[var(--glass-bg-subtle)] p-3 flex gap-2 mt-auto">
          <Zap className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <span>{insights.suggestion}</span>
        </p>
      </section>

      {/* KPIs */}
      <div className="xl:col-span-3 grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
        {kpis.map((k) => {
          const Icon = k.icon;
          return (
            <button
              key={k.label}
              onClick={() => onNavigateTab(k.tab)}
              className="card p-4 text-left hover:border-avocado-300 dark:hover:border-avocado-700 transition"
            >
              <Icon className="w-5 h-5 text-avocado-600 dark:text-avocado-400" />
              <p className="text-2xl font-bold mt-2 tabular-nums">{k.value}</p>
              <p className="text-xs text-[var(--text-muted)]">{k.label}</p>
            </button>
          );
        })}
      </div>

      {/* Recent purchases */}
      <section className="card p-5 xl:col-span-2">
        <div className="flex items-center justify-between">
          <h3 className="font-bold">{lang === 'es' ? 'Compras recientes' : 'Recent purchases'}</h3>
          <button
            onClick={() => onNavigateTab('analytics')}
            className="text-sm font-semibold text-avocado-700 dark:text-avocado-300 min-h-9"
          >
            {lang === 'es' ? 'Ver todo' : 'See all'}
          </button>
        </div>
        {purchases.length === 0 ? (
          <button
            onClick={onOpenScanner}
            className="mt-3 w-full rounded-2xl border-2 border-dashed border-avocado-300 dark:border-avocado-700 p-6 flex flex-col items-center gap-2 text-center hover:bg-avocado-50/50 dark:hover:bg-white/5"
          >
            <Camera className="w-7 h-7 text-avocado-600" />
            <span className="font-semibold">{lang === 'es' ? 'Escanea tu primera factura' : 'Scan your first receipt'}</span>
            <span className="text-sm text-[var(--text-muted)] max-w-xs">
              {lang === 'es'
                ? 'Con cada compra la app aprende cuánto consumen en casa y te avisa antes de que algo se acabe.'
                : 'Each purchase teaches the app how fast your home uses things.'}
            </span>
          </button>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--glass-border)]">
            {recent.map((purchase) => {
              const member = household.members.find((m) => m.id === purchase.createdBy);
              const kind = receiptFileKind(purchase.receiptImageUrl);
              return (
                <li key={purchase.id}>
                  <button onClick={() => onInspectPurchase(purchase)} className="w-full py-3 flex items-center gap-3 text-left group">
                    <span className="w-11 h-11 rounded-xl bg-avocado-50 dark:bg-avocado-500/10 overflow-hidden flex items-center justify-center shrink-0">
                      {kind === 'image' ? (
                        <img src={purchase.receiptImageUrl} alt="" className="w-full h-full object-cover object-top" />
                      ) : (
                        <Receipt className="w-5 h-5 text-avocado-600 dark:text-avocado-400" />
                      )}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block font-semibold text-sm truncate group-hover:text-avocado-700 dark:group-hover:text-avocado-300">
                        {purchase.supermarket}
                      </span>
                      <span className="block text-xs text-[var(--text-muted)] truncate">
                        {purchase.purchaseDate} · {purchase.items.length} {lang === 'es' ? 'productos' : 'items'}
                        {member ? ` · ${member.name.split(' ')[0]}` : ''}
                      </span>
                    </span>
                    <span className="font-semibold text-sm tabular-nums">{formatCurrency(purchase.totalAmount, cur)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Running low */}
      <section className="card p-5">
        <div className="flex items-center justify-between">
          <h3 className="font-bold">{lang === 'es' ? 'Por reponer pronto' : 'Running low'}</h3>
          <button
            onClick={() => onNavigateTab('restock-ai')}
            className="text-sm font-semibold text-avocado-700 dark:text-avocado-300 min-h-9"
          >
            {lang === 'es' ? 'Ver todo' : 'See all'}
          </button>
        </div>
        {runningLowItems.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--text-muted)]">
            {lang === 'es'
              ? `Cuando compres un producto ${household.minPurchasesForPrediction} veces, aquí verás cuándo se va a acabar.`
              : `Buy a product ${household.minPurchasesForPrediction} times to see when it will run out.`}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--glass-border)]">
            {runningLowItems.map((pred) => {
              const isUrgent = pred.estimatedDaysRemaining <= household.restockAlertDays;
              const days = Math.max(0, Math.round(pred.estimatedDaysRemaining));
              return (
                <li key={pred.canonicalName} className="py-3">
                  <div className="flex items-center gap-2.5">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${isUrgent ? 'bg-coral-500' : 'bg-avocado-400'}`} />
                    <span className="flex-1 min-w-0 text-sm font-medium truncate" title={pred.aiExplanation}>
                      {pred.canonicalName}
                    </span>
                    <span className={`text-xs shrink-0 ${isUrgent ? 'text-coral-500 font-semibold' : 'text-[var(--text-muted)]'}`}>
                      {daysLabel(days)}
                    </span>
                  </div>
                  <div className="flex gap-2 mt-2 pl-[18px]">
                    <button
                      onClick={() => onRestockFeedback(pred.canonicalName, 'ran_out')}
                      className="h-8 px-3 rounded-lg text-xs font-semibold bg-coral-500/10 text-coral-500 hover:bg-coral-500/15"
                    >
                      Se acabó
                    </button>
                    <button
                      onClick={() => onRestockFeedback(pred.canonicalName, 'still_have_some')}
                      className="h-8 px-3 rounded-lg text-xs font-semibold bg-avocado-50 text-avocado-700 hover:bg-avocado-100 dark:bg-avocado-500/10 dark:text-avocado-300"
                    >
                      Aún queda
                    </button>
                    <span className="ml-auto text-[11px] text-[var(--text-muted)] self-center hidden sm:inline">
                      {translateConfidence(pred.confidenceLevel, lang)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Category spend */}
      <section className="card p-5 xl:col-span-2">
        <div className="flex items-center justify-between">
          <h3 className="font-bold">{lang === 'es' ? 'Gasto por categoría' : 'Spend by category'}</h3>
          <button
            onClick={() => onNavigateTab('analytics')}
            className="text-sm font-semibold text-avocado-700 dark:text-avocado-300 min-h-9"
          >
            {lang === 'es' ? 'Analíticas' : 'Analytics'}
          </button>
        </div>
        <ul className="mt-3 grid sm:grid-cols-2 gap-x-8 gap-y-3">
          {categoryRows.slice(0, 8).map((cat) => {
            const isOver = cat.spent > cat.monthlyAllocation;
            return (
              <li key={cat.name}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
                    <span className="truncate">{translateCategory(cat.name, lang)}</span>
                    {isOver && (
                      <span className="text-[10px] px-1.5 rounded-full bg-coral-500/15 text-coral-500 font-semibold flex items-center gap-0.5 shrink-0">
                        <AlertCircle className="w-3 h-3" /> {lang === 'es' ? 'Excedido' : 'Over'}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-[var(--text-muted)] tabular-nums shrink-0">
                    <strong className="text-[var(--text-primary)] font-semibold">{formatCurrency(cat.spent, cur, true)}</strong> /{' '}
                    {formatCurrency(cat.monthlyAllocation, cur, true)}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-[var(--glass-bg-subtle)] mt-1.5 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${Math.max(3, cat.pct)}%`, backgroundColor: isOver ? '#e96f4e' : cat.color }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Quick add */}
      <section className="card p-5">
        <div className="flex items-center justify-between">
          <h3 className="font-bold">{lang === 'es' ? 'Agregar rápido a la lista' : 'Quick add to list'}</h3>
          <button
            onClick={() => onNavigateTab('shopping-list')}
            className="text-sm font-semibold text-avocado-700 dark:text-avocado-300 min-h-9"
          >
            {lang === 'es' ? 'Lista' : 'List'}
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          {FREQUENT_QUICK_CHIPS.map((chip) => {
            const isAdded = recentlyAddedChip === chip.canonicalName;
            return (
              <button
                key={chip.canonicalName}
                onClick={() => handleChipTap(chip)}
                className={`min-h-10 px-3 rounded-full text-sm font-medium flex items-center gap-1.5 border transition ${
                  isAdded
                    ? 'bg-avocado-600 border-avocado-600 text-white'
                    : 'border-[var(--input-border)] hover:border-avocado-400 hover:bg-avocado-50 dark:hover:bg-white/5'
                }`}
              >
                {isAdded ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4 text-avocado-600 dark:text-avocado-400" />}
                {chip.canonicalName}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
};

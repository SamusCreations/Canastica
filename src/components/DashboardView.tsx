import React, { useState } from 'react';
import {
  AlertCircle,
  ArrowUpRight,
  Camera,
  Check,
  Clock,
  Eye,
  Flame,
  Plus,
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
import { getCurrentMonthPrefix, monthLabel, monthName, monthProgress } from '../utils/dates';
import { Avatar } from './Avatar';

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

  // Compact SVG Ring geometry
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset =
    circumference - (Math.min(100, budgetPercentage) / 100) * circumference;

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

  return (
    <div className="space-y-3.5">
      {/* Row 1: Compact Horizontal Budget Ring (4 cols) + AI Insights & 1-Tap Chips (8 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
        {/* Col 1: Minimalist Horizontal Budget Card (4 cols) */}
        <div className="lg:col-span-4 liquid-glass rounded-xl p-3.5 flex flex-col justify-between gap-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
                {lang === 'es' ? 'Presupuesto Mensual' : 'Monthly Budget'}
              </h3>
              <p className="text-[11px] text-[var(--text-secondary)] font-medium">
                {monthLabel(monthPrefix, lang)} • {household.name}
              </p>
            </div>
            <span
              className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                budgetPercentage >= 85
                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                  : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
              }`}
            >
              {budgetPercentage}% {lang === 'es' ? 'usado' : 'used'}
            </span>
          </div>

          <div className="flex items-center gap-4">
            {/* Compact SVG Ring */}
            <div className="relative w-24 h-24 shrink-0 flex items-center justify-center">
              <svg className="w-24 h-24 -rotate-90 transform" viewBox="0 0 108 108">
                <circle
                  cx="54"
                  cy="54"
                  r={radius}
                  stroke="currentColor"
                  strokeWidth="9"
                  fill="transparent"
                  className="opacity-10"
                />
                <circle
                  cx="54"
                  cy="54"
                  r={radius}
                  stroke="#4f7f27"
                  strokeWidth="9"
                  strokeDasharray={circumference}
                  strokeDashoffset={strokeDashoffset}
                  strokeLinecap="round"
                  fill="transparent"
                  className="transition-all duration-700 ease-out"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="text-sm font-extrabold">{budgetPercentage}%</span>
                <span className="text-[9px] uppercase text-[var(--text-muted)] font-semibold">
                  {monthName(monthPrefix, lang, true)}
                </span>
              </div>
            </div>

            {/* Spend & KPI Breakdown */}
            <div className="flex-1 min-w-0 space-y-2">
              <div>
                <span className="text-[10px] uppercase text-[var(--text-muted)] block">
                  {lang === 'es' ? 'Gasto Acumulado' : 'Spent so far'}
                </span>
                <div className="text-lg font-extrabold tracking-tight truncate">
                  {formatCurrency(currentMonthSpent, cur)}
                </div>
                <span className="text-[11px] text-[var(--text-muted)]">
                  de {formatCurrency(household.monthlyBudget, cur)}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-[var(--glass-border)]">
                <div>
                  <span className="text-[10px] text-[var(--text-muted)] block">
                    {lang === 'es' ? 'Disponible' : 'Remaining'}
                  </span>
                  <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400">
                    {formatCurrency(budgetRemaining, cur, true)}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-[var(--text-muted)] block">
                    {lang === 'es' ? 'Ritmo/Día' : 'Daily Pace'}
                  </span>
                  <span className="text-xs font-bold text-avocado-600 dark:text-avocado-400">
                    {formatCurrency(budgetRemaining / daysLeftInMonth, cur, true)}/d
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Col 2: AI Insights & 1-Tap Quick Chips (8 cols) */}
        <div className="lg:col-span-8 liquid-glass rounded-xl p-3.5 flex flex-col justify-between gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg liquid-lens-btn flex items-center justify-center text-white shrink-0">
                <Sparkles className="w-3.5 h-3.5" />
              </div>
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-bold uppercase tracking-wider text-avocado-600 dark:text-avocado-400">
                  {lang === 'es' ? 'Resumen inteligente' : 'Smart insights'}
                </h2>
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 font-semibold">
                  Activo
                </span>
              </div>
            </div>
            <button
              onClick={() =>
                onOpenAssistantWithPrompt(
                  `¿Cuánto hemos gastado en ${monthName(monthPrefix, 'es').toLowerCase()} por categoría y dónde podemos ahorrar?`
                )
              }
              className="liquid-glass-subtle liquid-glass-interactive px-2.5 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1 text-avocado-600 dark:text-avocado-400 shrink-0"
            >
              Preguntar a IA <ArrowUpRight className="w-3 h-3" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5 items-center">
            <div className="md:col-span-7">
              <p className="text-xs sm:text-sm font-semibold leading-snug text-[var(--text-primary)]">
                “{insights.headline}”
              </p>
            </div>
            <div className="md:col-span-5 liquid-glass-subtle rounded-lg p-2.5 flex items-start gap-2">
              <Zap className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-[11px] text-[var(--text-secondary)] leading-snug line-clamp-2">
                <strong className="text-amber-600 dark:text-amber-400">Consejo:</strong>{' '}
                {insights.suggestion}
              </p>
            </div>
          </div>

          {/* 1-Tap Frequent Product Chips */}
          <div className="pt-2 border-t border-[var(--glass-border)] flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] mr-1">
                {lang === 'es' ? 'Agregado Rápido:' : 'Quick Add:'}
              </span>
              {FREQUENT_QUICK_CHIPS.map((chip) => {
                const isAdded = recentlyAddedChip === chip.canonicalName;
                return (
                  <button
                    key={chip.canonicalName}
                    onClick={() => handleChipTap(chip)}
                    className={`px-2 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 transition ${
                      isAdded
                        ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40'
                        : 'liquid-glass-subtle liquid-glass-interactive'
                    }`}
                  >
                    {isAdded ? (
                      <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <Plus className="w-3 h-3 text-avocado-600 dark:text-avocado-400" />
                    )}
                    <span>{chip.canonicalName}</span>
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => onNavigateTab('shopping-list')}
              className="text-[11px] text-avocado-600 dark:text-avocado-400 hover:underline font-bold shrink-0"
            >
              {lang === 'es' ? 'Lista →' : 'List →'}
            </button>
          </div>
        </div>
      </div>

      {/* Row 2: Running Low Soon (7 cols) + Category Spending Bars (5 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
        {/* Running Low Soon Card (7 cols) */}
        <div className="lg:col-span-7 liquid-glass rounded-xl p-3.5 flex flex-col justify-between gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Flame className="w-4 h-4 text-amber-500 shrink-0" />
              <h3 className="text-xs font-bold uppercase tracking-wider truncate">
                {lang === 'es' ? 'Por acabarse pronto' : 'Running low soon'}
              </h3>
              <span className="hidden sm:inline text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300">
                Unidades Base (ml/g/unid)
              </span>
            </div>
            <button
              onClick={() => onNavigateTab('restock-ai')}
              className="shrink-0 whitespace-nowrap min-h-[32px] text-xs font-bold text-avocado-600 dark:text-avocado-400 hover:underline"
            >
              {lang === 'es' ? 'Ver todo →' : 'See all →'}
            </button>
          </div>

          {runningLowItems.length === 0 && (
            <p className="text-sm text-[var(--text-muted)] liquid-glass-subtle rounded-lg p-3">
              {lang === 'es'
                ? `Cuando compres un producto ${household.minPurchasesForPrediction} veces, aquí verás cuándo se va a acabar.`
                : `Buy a product ${household.minPurchasesForPrediction} times to see when it will run out.`}
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {runningLowItems.map((pred) => {
              const isUrgent = pred.estimatedDaysRemaining <= household.restockAlertDays;
              const pctRemaining = Math.max(
                8,
                Math.min(
                  100,
                  Math.round(
                    (pred.estimatedDaysRemaining / Math.max(1, pred.expectedDurationDays)) * 100
                  )
                )
              );

              return (
                <div
                  key={pred.canonicalName}
                  className={`liquid-glass-subtle rounded-xl p-2.5 flex flex-col justify-between gap-2 border ${
                    isUrgent ? 'border-amber-500/40' : 'border-[var(--glass-border)]'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-bold text-xs truncate">{pred.canonicalName}</span>
                        <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 font-semibold shrink-0">
                          {translateConfidence(pred.confidenceLevel, lang)}
                        </span>
                      </div>
                      <span
                        className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full flex items-center gap-0.5 shrink-0 ${
                          isUrgent
                            ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300'
                            : 'bg-avocado-500/10 text-avocado-600 dark:text-avocado-400'
                        }`}
                      >
                        <Clock className="w-2.5 h-2.5" />~{Math.round(pred.estimatedDaysRemaining)}d
                      </span>
                    </div>

                    <p
                      className="text-[11px] text-[var(--text-secondary)] leading-snug mt-1 line-clamp-2"
                      title={pred.aiExplanation}
                    >
                      {pred.aiExplanation}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          isUrgent ? 'bg-amber-500' : 'bg-avocado-600'
                        }`}
                        style={{ width: `${pctRemaining}%` }}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-1.5">
                      <button
                        onClick={() => onRestockFeedback(pred.canonicalName, 'ran_out')}
                        className="flex-1 py-1 rounded-md text-[10px] font-bold bg-rose-500/12 hover:bg-rose-500/20 text-rose-700 dark:text-rose-300 transition"
                      >
                        Se acabó
                      </button>
                      <button
                        onClick={() => onRestockFeedback(pred.canonicalName, 'still_have_some')}
                        className="flex-1 py-1 rounded-md text-[10px] font-bold bg-emerald-500/12 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 transition"
                      >
                        Aún queda
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Category Spending Bars (5 cols) */}
        <div className="lg:col-span-5 liquid-glass rounded-xl p-3.5 flex flex-col justify-between gap-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <TrendingUp className="w-4 h-4 text-avocado-600 dark:text-avocado-400" />
              <h3 className="text-xs font-bold uppercase tracking-wider">
                {lang === 'es' ? 'Gasto por Categoría' : 'Category Spend'}
              </h3>
            </div>
            <button
              onClick={() => onNavigateTab('analytics')}
              className="text-[11px] font-bold text-avocado-600 dark:text-avocado-400 hover:underline"
            >
              Analíticas →
            </button>
          </div>

          <div className="space-y-2 flex-1 flex flex-col justify-center">
            {categoryRows.slice(0, 7).map((cat) => {
              const isOver = cat.spent > cat.monthlyAllocation;
              return (
                <div key={cat.name} className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: cat.color }}
                      />
                      <span className="font-semibold truncate">
                        {translateCategory(cat.name, lang)}
                      </span>
                      {isOver && (
                        <span className="text-[9px] px-1 py-0.2 rounded bg-rose-500/15 text-rose-600 dark:text-rose-400 font-bold flex items-center gap-0.5 shrink-0">
                          <AlertCircle className="w-2.5 h-2.5" /> Excedido
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[11px] shrink-0">
                      <span className="font-bold">{formatCurrency(cat.spent, cur)}</span>
                      <span className="text-[var(--text-muted)]">
                        {' '}
                        / {formatCurrency(cat.monthlyAllocation, cur, true)}
                      </span>
                    </div>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-700"
                      style={{
                        width: `${Math.max(4, cat.pct)}%`,
                        backgroundColor: isOver ? '#e11d48' : cat.color,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Row 3: Recent Purchases Strip (4 Compact Horizontal Cards) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-0.5">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">
              {lang === 'es' ? 'Facturas Recientes' : 'Recent Receipts'}
            </h3>
            <span className="text-[11px] text-[var(--text-muted)] hidden sm:inline">
              • Haz clic en una factura para ver la foto original y el desglose
            </span>
          </div>
          <button
            onClick={onOpenScanner}
            className="text-[11px] font-bold text-avocado-600 dark:text-avocado-400 hover:underline flex items-center gap-1"
          >
            <Camera className="w-3 h-3" />
            {lang === 'es' ? '+ Nueva Factura' : '+ Scan Receipt'}
          </button>
        </div>

        {purchases.length === 0 && (
          <button
            onClick={onOpenScanner}
            className="w-full liquid-glass liquid-glass-interactive rounded-xl p-5 flex flex-col items-center gap-2 text-center border-dashed"
          >
            <span className="w-11 h-11 rounded-xl liquid-lens-btn flex items-center justify-center">
              <Camera className="w-5 h-5" />
            </span>
            <span className="text-sm font-bold">
              {lang === 'es' ? 'Escanea tu primera factura' : 'Scan your first receipt'}
            </span>
            <span className="hidden sm:block text-xs text-[var(--text-muted)] max-w-xs">
              {lang === 'es'
                ? 'Con cada compra la app aprende cuánto consumen en casa y te avisa antes de que algo se acabe.'
                : 'Each purchase teaches the app how fast your home uses things.'}
            </span>
          </button>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {purchases.slice(0, 4).map((purchase) => {
            const member = household.members.find((m) => m.id === purchase.createdBy);
            return (
              <div
                key={purchase.id}
                onClick={() => onInspectPurchase(purchase)}
                className="liquid-glass liquid-glass-interactive rounded-xl p-3 flex flex-col justify-between gap-2 group"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-avocado-500/10 text-avocado-600 dark:text-avocado-400 inline-block truncate max-w-full">
                      {purchase.supermarket}
                    </span>
                    <h4 className="text-base font-extrabold mt-1 tracking-tight">
                      {formatCurrency(purchase.totalAmount, cur)}
                    </h4>
                    <p className="text-[10px] text-[var(--text-muted)]">{purchase.purchaseDate}</p>
                  </div>

                  {/* Receipt Mini Thumbnail */}
                  <div className="w-9 h-11 rounded-md overflow-hidden border border-[var(--glass-border)] bg-white shrink-0 relative">
                    <img
                      src={purchase.receiptImageUrl}
                      alt="Factura"
                      className="w-full h-full object-cover object-top"
                    />
                    <div className="absolute inset-0 bg-slate-900/35 opacity-0 group-hover:opacity-100 flex items-center justify-center transition">
                      <Eye className="w-3 h-3 text-white" />
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-[var(--glass-border)] text-[11px]">
                  {member && (
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Avatar name={member.name} src={member.avatarUrl} color={member.accentColor} className="w-5 h-5" />
                      <span className="font-medium truncate">{member.name.split(' ')[0]}</span>
                    </div>
                  )}
                  <span className="text-[10px] text-[var(--text-muted)] font-medium shrink-0">
                    {purchase.items.length} ítems →
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

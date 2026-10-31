import React, { useState } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Clock,
  Info,
  Layers,
  Plus,
  Scale,
  Sparkles,
} from 'lucide-react';
import {
  GroceryCategory,
  Household,
  RestockPrediction,
  UnpredictedProductProgress,
} from '../types/grocery';
import { translateCategory, translateConfidence } from '../utils/formatters';

interface RestockPredictionViewProps {
  household: Household;
  predictions: RestockPrediction[];
  learningProducts: UnpredictedProductProgress[];
  onUpdateSettings: (settings: {
    restockLookbackMonths?: 3 | 6 | 12;
    restockAlertDays?: number;
    minPurchasesForPrediction?: number;
  }) => void;
  onRestockFeedback: (canonicalName: string, feedback: 'ran_out' | 'still_have_some') => void;
  onAddPredictedToList: (item: {
    name: string;
    canonicalName: string;
    category: GroceryCategory;
    quantity: number;
    unit: string;
    isPredicted: boolean;
    predictedReason: string;
  }) => void;
}

export const RestockPredictionView: React.FC<RestockPredictionViewProps> = ({
  household,
  predictions,
  learningProducts,
  onUpdateSettings,
  onRestockFeedback,
  onAddPredictedToList,
}) => {
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);
  const lang = household.language;

  return (
    <div className="space-y-3.5">
      {/* Compact Header & Configurable Engine Parameters */}
      <div className="liquid-glass rounded-xl p-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg liquid-lens-btn flex items-center justify-center text-white shrink-0">
              <Activity className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold">
                  Motor de Predicción de Reposición con IA
                </h2>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-avocado-500/10 text-avocado-600 dark:text-avocado-400">
                  Diario
                </span>
              </div>
              <p className="hidden sm:block text-[11px] text-[var(--text-muted)]">
                Normalización a unidades base (ml, g, unid), tasa ponderada y ajuste a la última cantidad comprada
              </p>
            </div>
          </div>

          {/* Configurable Parameters Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="liquid-glass-subtle rounded-lg p-1 flex items-center gap-1">
              <span className="text-[11px] font-semibold px-1.5 text-[var(--text-secondary)]">
                Periodo:
              </span>
              {([3, 6, 12] as const).map((months) => (
                <button
                  key={months}
                  onClick={() => onUpdateSettings({ restockLookbackMonths: months })}
                  className={`px-2 py-0.5 rounded-md text-[11px] font-bold transition ${
                    household.restockLookbackMonths === months
                      ? 'liquid-lens-btn text-white'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {months}M
                </button>
              ))}
            </div>

            <div className="liquid-glass-subtle rounded-lg px-2.5 py-1 flex items-center gap-1.5">
              <span className="text-[11px] font-semibold text-[var(--text-secondary)]">
                Auto-Añadir:
              </span>
              <select
                value={household.restockAlertDays}
                onChange={(e) =>
                  onUpdateSettings({ restockAlertDays: parseInt(e.target.value, 10) || 2 })
                }
                className="bg-transparent text-[11px] font-bold text-avocado-600 dark:text-avocado-400 focus:outline-none"
              >
                <option value={1}>≤ 1 día</option>
                <option value={2}>≤ 2 días (Defecto)</option>
                <option value={3}>≤ 3 días</option>
                <option value={5}>≤ 5 días</option>
              </select>
            </div>
          </div>
        </div>

        {/* Sleek Inline Methodology Strip */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pt-1 border-t border-[var(--glass-border)] text-[11px]">
          <div className="flex items-center gap-2 text-[var(--text-secondary)]">
            <Scale className="w-3.5 h-3.5 text-avocado-600 dark:text-avocado-400 shrink-0" />
            <span className="truncate">
              <strong>1. Unidad Base:</strong> 1 Galón (3,785 ml) = 2×900ml + 2×1L
            </span>
          </div>
          <div className="flex items-center gap-2 text-[var(--text-secondary)]">
            <Activity className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 shrink-0" />
            <span className="truncate">
              <strong>2. Promedio Ponderado:</strong> Mayor peso a compras recientes
            </span>
          </div>
          <div className="flex items-center gap-2 text-[var(--text-secondary)]">
            <Clock className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="truncate">
              <strong>3. Ajuste por Cantidad:</strong> 1,800 ml a 270 ml/d → ~7 días
            </span>
          </div>
        </div>
      </div>

      {/* 3-Column Responsive Desktop Grid for Predicted Products (All 6 fit in 2 rows!) */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
        {predictions.map((pred) => {
          const isExpanded = expandedProduct === pred.canonicalName;
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
              className={`liquid-glass rounded-xl p-3.5 flex flex-col justify-between gap-2.5 border ${
                isUrgent ? 'border-amber-500/45' : 'border-[var(--glass-border)]'
              }`}
            >
              {/* Top Row: Product Title, Category, Confidence & Days Remaining */}
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <h3 className="text-sm font-extrabold truncate">{pred.canonicalName}</h3>
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-500/10 text-[var(--text-secondary)] font-semibold">
                        {translateCategory(pred.category, lang)}
                      </span>
                      <span
                        className={`text-[9px] font-bold uppercase px-1.5 py-0.2 rounded-full ${
                          pred.confidenceLevel === 'high'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : pred.confidenceLevel === 'medium'
                            ? 'bg-avocado-500/15 text-avocado-700 dark:text-avocado-300'
                            : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                        }`}
                      >
                        {pred.confidenceScore}%
                      </span>
                    </div>

                    {/* Grouped Variants */}
                    <div className="flex items-center gap-1 mt-1 text-[10px] text-[var(--text-muted)] truncate">
                      <Layers className="w-3 h-3 text-avocado-600 dark:text-avocado-400 shrink-0" />
                      <span className="truncate" title={pred.groupedVariants.join(' • ')}>
                        {pred.groupedVariants.join(' • ')}
                      </span>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-extrabold ${
                        isUrgent
                          ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300'
                          : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                      }`}
                    >
                      <Clock className="w-3 h-3" />~{Math.round(pred.estimatedDaysRemaining)}d
                    </span>
                  </div>
                </div>

                {/* Gemini Natural Language Explanation */}
                <div
                  className="liquid-glass-subtle rounded-lg p-2 text-xs text-[var(--text-secondary)] leading-snug"
                  title={pred.aiExplanation}
                >
                  <p className="line-clamp-3">
                    <Sparkles className="w-3 h-3 text-avocado-600 dark:text-avocado-400 inline mr-1 -mt-0.5" />
                    {pred.aiExplanation}
                  </p>
                </div>
              </div>

              {/* Metrics Strip + Progress Bar + Feedback Buttons */}
              <div className="space-y-2">
                <div className="grid grid-cols-3 gap-1.5 text-center liquid-glass-subtle rounded-lg p-2">
                  <div>
                    <span className="text-[9px] uppercase text-[var(--text-muted)] block">
                      Consumo
                    </span>
                    <span className="text-[11px] font-extrabold text-avocado-600 dark:text-avocado-400">
                      {pred.weightedDailyRate} {pred.baseUnit}/d
                    </span>
                  </div>
                  <div>
                    <span className="text-[9px] uppercase text-[var(--text-muted)] block">
                      Últ. Compra
                    </span>
                    <span className="text-[11px] font-bold block truncate">
                      {pred.lastPurchaseBaseQty.toLocaleString('es-CR')} {pred.baseUnit}
                    </span>
                  </div>
                  <div>
                    <span className="text-[9px] uppercase text-[var(--text-muted)] block">
                      Duración
                    </span>
                    <span className="text-[11px] font-bold">
                      {pred.expectedDurationDays}d ({pred.purchaseCount}c)
                    </span>
                  </div>
                </div>

                <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      isUrgent ? 'bg-amber-500' : 'bg-avocado-600'
                    }`}
                    style={{ width: `${pctRemaining}%` }}
                  />
                </div>

                {/* User Feedback & Action Buttons */}
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => onRestockFeedback(pred.canonicalName, 'ran_out')}
                      className="px-2 py-1 rounded-md text-[10px] font-bold bg-rose-500/12 hover:bg-rose-500/20 text-rose-700 dark:text-rose-300 transition"
                    >
                      Se acabó
                    </button>
                    <button
                      onClick={() => onRestockFeedback(pred.canonicalName, 'still_have_some')}
                      className="px-2 py-1 rounded-md text-[10px] font-bold bg-emerald-500/12 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 transition"
                    >
                      Aún queda
                    </button>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() =>
                        onAddPredictedToList({
                          name: pred.canonicalName,
                          canonicalName: pred.canonicalName,
                          category: pred.category,
                          quantity: 1,
                          unit: pred.lastPurchaseDisplayQty,
                          isPredicted: true,
                          predictedReason: `Predicción IA: ~${Math.round(pred.estimatedDaysRemaining)}d (${pred.weightedDailyRate} ${pred.baseUnit}/día)`,
                        })
                      }
                      className="px-2 py-1 rounded-md text-[10px] font-bold bg-avocado-500/12 hover:bg-avocado-500/20 text-avocado-700 dark:text-avocado-300 flex items-center gap-0.5 transition"
                    >
                      <Plus className="w-3 h-3" /> Lista
                    </button>
                    <button
                      onClick={() =>
                        setExpandedProduct(isExpanded ? null : pred.canonicalName)
                      }
                      className="p-1 rounded-md liquid-glass-subtle liquid-glass-interactive"
                      title="Ver intervalos históricos"
                    >
                      {isExpanded ? (
                        <ChevronUp className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Expandable Interval Calculation Breakdown */}
              {isExpanded && (
                <div className="pt-2 border-t border-[var(--glass-border)] space-y-1.5 animate-spring-in">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="font-bold text-avocado-600 dark:text-avocado-400">
                      Intervalos de Compra ({translateConfidence(pred.confidenceLevel, lang)})
                    </span>
                    <span className="text-[var(--text-muted)]">
                      Factor usuario: ×{pred.feedbackMultiplier.toFixed(2)}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[10px]">
                      <thead>
                        <tr className="border-b border-[var(--glass-border)] text-[var(--text-muted)]">
                          <th className="py-1 pr-1.5">Compra</th>
                          <th className="py-1 pr-1.5">Cant. Base</th>
                          <th className="py-1 pr-1.5">Días</th>
                          <th className="py-1 pr-1.5">Tasa/Día</th>
                          <th className="py-1">Peso</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--glass-border)]">
                        {pred.intervals.map((intv, idx) => (
                          <tr key={idx}>
                            <td className="py-1 pr-1.5 font-mono">{intv.purchaseDate}</td>
                            <td className="py-1 pr-1.5 font-semibold text-avocado-600 dark:text-avocado-400">
                              {intv.displayQuantity}
                            </td>
                            <td className="py-1 pr-1.5">{intv.daysElapsed}d</td>
                            <td className="py-1 pr-1.5 font-mono">
                              {intv.dailyRateInInterval} {pred.baseUnit}/d
                            </td>
                            <td className="py-1 font-mono text-purple-600 dark:text-purple-400">
                              w={intv.recencyWeight}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Products Still Learning (Under Minimum Purchase Threshold) */}
      {learningProducts.length > 0 && (
        <div className="liquid-glass rounded-xl p-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Info className="w-3.5 h-3.5 text-avocado-600 dark:text-avocado-400 shrink-0" />
            <span className="text-[11px] font-bold text-[var(--text-secondary)]">
              Recopilando Historial (Mín. {household.minPurchasesForPrediction} compras):
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {learningProducts.map((lp) => (
              <div
                key={lp.canonicalName}
                className="liquid-glass-subtle rounded-lg px-2.5 py-1 flex items-center gap-2 text-[11px]"
              >
                <span className="font-bold">{lp.canonicalName}</span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-500/10 text-[var(--text-muted)]">
                  {lp.purchaseCount}/{lp.requiredCount} compras
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

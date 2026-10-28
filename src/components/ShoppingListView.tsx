import React, { useState } from 'react';
import {
  Check,
  CheckCircle2,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import {
  describeAiQuota,
  MAX_SHOPPING_TEXT_CHARS,
  parseNaturalLanguageShoppingInput,
} from '../services/geminiAndSupabaseService';
import { useAiQuota } from '../lib/useAiQuota';
import {
  AutoCrossOffSummary,
  GroceryCategory,
  Household,
  RestockPrediction,
  ShoppingListItem,
} from '../types/grocery';
import { translateCategory } from '../utils/formatters';
import { Avatar } from './Avatar';

interface ShoppingListViewProps {
  household: Household;
  items: ShoppingListItem[];
  predictions: RestockPrediction[];
  autoCrossOffSummary: AutoCrossOffSummary | null;
  onAddParsedItems: (
    parsed: {
      name: string;
      canonicalName: string;
      category: GroceryCategory;
      quantity: number;
      unit: string;
      isPredicted?: boolean;
      predictedReason?: string;
    }[]
  ) => void;
  onToggleItem: (id: string) => void;
  onDeleteItem: (id: string) => void;
  onClearChecked: () => void;
  onUndoAutoCrossOff: () => void;
  onOpenScanner: () => void;
}

const EXAMPLE_NL_INPUTS = [
  '2 litros de leche, pan integral y detergente',
  '1.5 kg de pechuga de pollo, 1 kg de aguacate y 500g de café',
  '12 huevos, queso turrialba y 2 kg de arroz',
];

export const ShoppingListView: React.FC<ShoppingListViewProps> = ({
  household,
  items,
  predictions,
  autoCrossOffSummary,
  onAddParsedItems,
  onToggleItem,
  onDeleteItem,
  onClearChecked,
  onUndoAutoCrossOff,
  onOpenScanner,
}) => {
  const [nlInput, setNlInput] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const lang = household.language;
  const aiQuota = useAiQuota();
  const aiAvailable = !aiQuota || aiQuota.exempt || aiQuota.remaining > 0;

  const handleParseAndAdd = async (e?: React.FormEvent, overrideText?: string) => {
    if (e) e.preventDefault();
    const text = (overrideText ?? nlInput).trim();
    if (!text) return;

    setIsParsing(true);
    try {
      const parsed = await parseNaturalLanguageShoppingInput(text, lang === 'en' ? 'en' : 'es');
      if (parsed.length > 0) {
        onAddParsedItems(parsed);
        if (!overrideText) setNlInput('');
      }
    } finally {
      setIsParsing(false);
    }
  };

  const pendingItems = items.filter((i) => !i.isChecked);
  const checkedItems = items.filter((i) => i.isChecked);

  const aisleOrderMap = new Map(
    household.categories.map((c) => [c.name, c.aisleOrder])
  );
  const categoryColorMap = new Map(
    household.categories.map((c) => [c.name, c.color])
  );

  const groupedByCategory = new Map<GroceryCategory, ShoppingListItem[]>();
  for (const item of pendingItems) {
    const list = groupedByCategory.get(item.category) || [];
    list.push(item);
    groupedByCategory.set(item.category, list);
  }

  const sortedCategories = Array.from(groupedByCategory.keys()).sort(
    (a, b) => (aisleOrderMap.get(a) || 99) - (aisleOrderMap.get(b) || 99)
  );

  const activeCanonicalSet = new Set(
    pendingItems.map((i) => (i.canonicalName || i.name).toLowerCase())
  );
  const smartSuggestions = predictions.filter(
    (p) => !activeCanonicalSet.has(p.canonicalName.toLowerCase())
  );

  return (
    <div className="space-y-3.5">
      {/* Compact Natural Language Input Bar */}
      <div className="liquid-glass rounded-xl p-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg liquid-lens-btn flex items-center justify-center text-white shrink-0">
              <Wand2 className="w-3.5 h-3.5" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider">
                Agregar escribiendo
              </h2>
              <span className="text-[11px] text-[var(--text-muted)] hidden md:inline">
                — Escribe varios productos y se separan y agrupan por pasillo
              </span>
            </div>
          </div>

          <button
            onClick={onOpenScanner}
            className="liquid-glass-subtle liquid-glass-interactive px-3 py-1 rounded-lg text-xs font-bold text-avocado-600 dark:text-avocado-400 flex items-center gap-1.5"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Escanear Factura para Autotachar
          </button>
        </div>

        <form onSubmit={(e) => handleParseAndAdd(e)} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={nlInput}
            maxLength={MAX_SHOPPING_TEXT_CHARS}
            onChange={(e) => setNlInput(e.target.value)}
            placeholder='Escribe ej.: "2 litros de leche, pan integral y detergente"...'
            className="liquid-input flex-1 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-medium"
          />
          <button
            type="submit"
            disabled={isParsing || !nlInput.trim()}
            className="liquid-lens-btn px-4 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50 shrink-0"
          >
            {isParsing ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Desglosando...
              </>
            ) : (
              <>
                <Plus className="w-3.5 h-3.5" />
                {aiAvailable ? 'Añadir con IA' : 'Añadir'}
              </>
            )}
          </button>
        </form>

        {aiQuota && !aiQuota.exempt && (
          <p className={`text-[11px] ${aiAvailable ? 'text-[var(--text-muted)]' : 'text-amber-700 dark:text-amber-300 font-semibold'}`}>
            {describeAiQuota(aiQuota)}
            {!aiAvailable && ' Mientras tanto, la lista se separa por comas sin IA.'}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
            Ejemplos:
          </span>
          {EXAMPLE_NL_INPUTS.map((sample) => (
            <button
              key={sample}
              type="button"
              onClick={() => {
                setNlInput(sample);
                handleParseAndAdd(undefined, sample);
              }}
              className="text-[11px] px-2 py-0.5 rounded-md liquid-glass-subtle liquid-glass-interactive text-[var(--text-secondary)]"
            >
              “{sample}”
            </button>
          ))}
        </div>
      </div>

      {/* Auto-Cross-Off Summary Banner */}
      {autoCrossOffSummary && (
        <div className="liquid-glass rounded-xl p-3 border border-emerald-500/40 bg-emerald-500/10 animate-spring-in space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <div className="text-xs">
                <strong className="text-emerald-700 dark:text-emerald-300">
                  Autotachado con IA ({autoCrossOffSummary.supermarket}):
                </strong>{' '}
                Se tacharon <strong>{autoCrossOffSummary.crossedOffItems.length} productos</strong>{' '}
                y quedan <strong>{autoCrossOffSummary.pendingCount} pendientes</strong>.
              </div>
            </div>

            <button
              onClick={onUndoAutoCrossOff}
              className="px-3 py-1 rounded-lg liquid-glass liquid-glass-interactive text-[11px] font-bold flex items-center gap-1 shrink-0"
            >
              <RotateCcw className="w-3 h-3 text-amber-500" />
              Deshacer
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {autoCrossOffSummary.crossedOffItems.map((match) => (
              <div
                key={match.shoppingListItemId}
                className="liquid-glass-subtle rounded-lg px-2.5 py-1.5 text-[11px] flex items-center justify-between gap-2"
              >
                <span className="line-through text-[var(--text-muted)] truncate">
                  {match.shoppingListName}
                </span>
                <span className="text-emerald-600 dark:text-emerald-400 font-semibold truncate">
                  ↔ {match.matchedReceiptItemName}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Compact AI Smart Suggestions Strip */}
      {smartSuggestions.length > 0 && (
        <div className="liquid-glass rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                Sugerencias Inteligentes de Reposición (Historial)
              </h3>
            </div>
            <span className="text-[10px] text-[var(--text-muted)]">1 clic para añadir</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            {smartSuggestions.slice(0, 4).map((sug) => (
              <div
                key={sug.canonicalName}
                className="liquid-glass-subtle rounded-lg px-3 py-2 flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-xs truncate">{sug.canonicalName}</span>
                    <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 font-bold shrink-0">
                      ~{Math.round(sug.estimatedDaysRemaining)}d
                    </span>
                  </div>
                  <p className="text-[10px] text-[var(--text-muted)] truncate">
                    {sug.weightedDailyRate} {sug.baseUnit}/día
                  </p>
                </div>
                <button
                  onClick={() =>
                    onAddParsedItems([
                      {
                        name: sug.canonicalName,
                        canonicalName: sug.canonicalName,
                        category: sug.category,
                        quantity: 1,
                        unit: sug.lastPurchaseDisplayQty,
                        isPredicted: true,
                        predictedReason: `Sugerido IA (~${Math.round(sug.estimatedDaysRemaining)}d restantes)`,
                      },
                    ])
                  }
                  className="px-2.5 py-1 rounded-md bg-avocado-500/12 hover:bg-avocado-500/20 text-avocado-700 dark:text-avocado-300 text-[11px] font-bold flex items-center gap-1 shrink-0 transition"
                >
                  <Plus className="w-3 h-3" /> Añadir
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active Shopping List Grouped by Supermarket Aisle (4 Columns on Desktop for Zero Scroll) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {sortedCategories.map((category) => {
          const catItems = groupedByCategory.get(category) || [];
          const aisleNum = aisleOrderMap.get(category) || 1;
          const color = categoryColorMap.get(category) || '#4f7f27';

          return (
            <div key={category} className="liquid-glass rounded-xl p-3 space-y-2.5">
              <div className="flex items-center justify-between border-b border-[var(--glass-border)] pb-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <h3 className="text-xs font-bold truncate">
                    {translateCategory(category, lang)}
                  </h3>
                  <span className="text-[9px] font-mono uppercase px-1.5 py-0.2 rounded bg-slate-500/10 text-[var(--text-muted)] shrink-0">
                    Pasillo {aisleNum}
                  </span>
                </div>
                <span className="text-[11px] font-bold text-[var(--text-muted)]">
                  {catItems.length}
                </span>
              </div>

              <div className="space-y-1.5">
                {catItems.map((item) => {
                  const creator = household.members.find((m) => m.id === item.createdBy);
                  return (
                    <div
                      key={item.id}
                      className="liquid-glass-subtle rounded-lg px-2.5 py-2 flex items-center justify-between gap-2 group"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <button
                          onClick={() => onToggleItem(item.id)}
                          className="w-4 h-4 rounded border-2 border-avocado-500/60 hover:bg-avocado-500/20 flex items-center justify-center transition shrink-0"
                          aria-label={`Tachar ${item.name}`}
                        >
                          <Check className="w-2.5 h-2.5 opacity-0 group-hover:opacity-60 text-avocado-600" />
                        </button>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold truncate">{item.name}</span>
                            <span className="text-[10px] px-1 py-0.2 rounded bg-slate-500/10 font-mono shrink-0">
                              {item.quantity} {item.unit}
                            </span>
                            {item.isPredicted && (
                              <span
                                className="text-[9px] font-bold px-1 py-0.2 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 shrink-0"
                                title={item.predictedReason || 'Predicted'}
                              >
                                IA
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {creator && (
                          <Avatar name={creator.name} src={creator.avatarUrl} color={creator.accentColor} className="w-4 h-4" />
                        )}
                        <button
                          onClick={() => onDeleteItem(item.id)}
                          className="p-1 rounded opacity-50 hover:opacity-100 hover:bg-rose-500/15 text-rose-500 transition"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Checked / Crossed-Off Items Section */}
      {checkedItems.length > 0 && (
        <div className="liquid-glass rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 text-[var(--text-secondary)]">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              Productos Tachados ({checkedItems.length})
            </h3>
            <button
              onClick={onClearChecked}
              className="text-[11px] text-rose-600 dark:text-rose-400 hover:underline font-bold"
            >
              Limpiar Tachados
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {checkedItems.map((item) => (
              <div
                key={item.id}
                onClick={() => onToggleItem(item.id)}
                className="liquid-glass-subtle liquid-glass-interactive rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-3.5 h-3.5 rounded bg-emerald-500/20 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
                    <Check className="w-2.5 h-2.5" />
                  </div>
                  <div className="min-w-0">
                    <span className="text-[11px] line-through text-[var(--text-muted)] block truncate">
                      {item.name} ({item.quantity} {item.unit})
                    </span>
                    {item.matchedReceiptItemName && (
                      <span className="text-[10px] text-emerald-600 dark:text-emerald-400 block truncate font-medium">
                        ↔ {item.matchedReceiptItemName}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

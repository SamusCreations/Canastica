import React, { useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Clock,
  Loader2,
  MapPin,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import {
  describeAiQuota,
  MAX_SHOPPING_TEXT_CHARS,
  parseShoppingInputLocally,
  parseShoppingInputWithAI,
} from '../services/geminiAndSupabaseService';
import { askNotificationPermission, enqueueAiRequest, removeAiQueueEntry, withAiTimeout } from '../lib/aiQueue';
import { useAiQuota } from '../lib/useAiQuota';
import { buildStoreSuggestions, suggestedStoreFor } from '../lib/storeSuggestion';
import {
  AutoCrossOffSummary,
  GroceryCategory,
  Household,
  Purchase,
  RestockPrediction,
  ShoppingListItem,
} from '../types/grocery';
import { translateCategory } from '../utils/formatters';
import { Avatar } from './Avatar';

interface ShoppingListViewProps {
  household: Household;
  householdId: string;
  items: ShoppingListItem[];
  purchases: Purchase[];
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
      store?: string;
    }[]
  ) => void;
  onToggleItem: (id: string) => void;
  onSetStore: (id: string, store: string | undefined) => void;
  onDeleteItem: (id: string) => void;
  onClearChecked: () => void;
  onUndoAutoCrossOff: () => void;
  onOpenScanner: () => void;
}

const EXAMPLE_NL_INPUTS = [
  '2 litros de leche, pan integral y detergente en Palí',
  '1.5 kg de pechuga de pollo, 1 kg de aguacate y 500g de café',
  '12 huevos, queso turrialba y 2 kg de arroz',
];

export const ShoppingListView: React.FC<ShoppingListViewProps> = ({
  household,
  householdId,
  items,
  purchases,
  predictions,
  autoCrossOffSummary,
  onAddParsedItems,
  onToggleItem,
  onSetStore,
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

  // Text the AI could not handle in time: the user picks the queue or manual entry
  const [stalled, setStalled] = useState<{ text: string; reason: 'slow' | 'down' } | null>(null);
  const [queuedNotice, setQueuedNotice] = useState('');
  const lateParseRef = useRef<{ text: string; queueId: string | null; waiting: boolean } | null>(null);

  const addParsed = (items: ReturnType<typeof parseShoppingInputLocally>, fromInput: boolean) => {
    if (items.length === 0) return;
    onAddParsedItems(items);
    if (fromInput) setNlInput('');
  };

  const handleParseAndAdd = async (e?: React.FormEvent, overrideText?: string) => {
    if (e) e.preventDefault();
    const text = (overrideText ?? nlInput).trim();
    if (!text) return;
    const language = lang === 'en' ? 'en' : 'es';

    setIsParsing(true);
    setStalled(null);
    setQueuedNotice('');
    try {
      const timed = await withAiTimeout(parseShoppingInputWithAI(text, language));
      if (timed.timedOut) {
        const pending = { text, queueId: null as string | null, waiting: true };
        lateParseRef.current = pending;
        setStalled({ text, reason: 'slow' });
        timed.late.then((items) => {
          if (!items) return;
          const result = items.length > 0 ? items : parseShoppingInputLocally(text);
          if (pending.queueId) {
            // Answered after all: add it now and drop it from the queue
            removeAiQueueEntry(pending.queueId);
            onAddParsedItems(result);
          } else if (pending.waiting && lateParseRef.current === pending) {
            lateParseRef.current = null;
            setStalled(null);
            addParsed(result, !overrideText);
          }
        });
        return;
      }
      if (timed.value === null) {
        setStalled({ text, reason: 'down' });
        return;
      }
      addParsed(timed.value.length > 0 ? timed.value : parseShoppingInputLocally(text), !overrideText);
    } finally {
      setIsParsing(false);
    }
  };

  const handleQueueStalled = () => {
    if (!stalled) return;
    const entry = enqueueAiRequest({
      kind: 'shopping',
      householdId,
      text: stalled.text,
      language: lang === 'en' ? 'en' : 'es',
    });
    if (lateParseRef.current) {
      lateParseRef.current.queueId = entry?.id ?? null;
      lateParseRef.current.waiting = false;
    }
    setStalled(null);
    if (!entry) {
      setQueuedNotice('La cola está llena. Agrégalo a mano o inténtalo más tarde.');
      return;
    }
    askNotificationPermission();
    setNlInput('');
    setQueuedNotice('En cola: se agregará a la lista cuando la IA esté disponible.');
  };

  const handleManualStalled = () => {
    if (!stalled) return;
    if (lateParseRef.current) lateParseRef.current.waiting = false;
    lateParseRef.current = null;
    addParsed(parseShoppingInputLocally(stalled.text), true);
    setStalled(null);
  };

  const pendingItems = items.filter((i) => !i.isChecked);
  const checkedItems = items.filter((i) => i.isChecked);

  const aisleOrderMap = new Map(
    household.categories.map((c) => [c.name, c.aisleOrder])
  );
  const categoryColorMap = new Map(
    household.categories.map((c) => [c.name, c.color])
  );

  // Group by place of purchase: the one the user chose, else the most common one in past receipts
  const storeSuggestions = React.useMemo(() => buildStoreSuggestions(purchases), [purchases]);
  const NO_STORE = '';
  const effectiveStore = (item: ShoppingListItem) =>
    item.store || suggestedStoreFor(storeSuggestions, item) || NO_STORE;

  const groupedByStore = new Map<string, ShoppingListItem[]>();
  for (const item of pendingItems) {
    const store = effectiveStore(item);
    const list = groupedByStore.get(store) || [];
    list.push(item);
    groupedByStore.set(store, list);
  }
  for (const list of groupedByStore.values()) {
    list.sort(
      (a, b) => (aisleOrderMap.get(a.category) || 99) - (aisleOrderMap.get(b.category) || 99)
    );
  }

  // Stores with more items first; items without a place go last
  const sortedStores = Array.from(groupedByStore.keys()).sort((a, b) => {
    if (a === NO_STORE) return 1;
    if (b === NO_STORE) return -1;
    return (groupedByStore.get(b)?.length || 0) - (groupedByStore.get(a)?.length || 0);
  });

  const storeOptions = Array.from(
    new Set([
      ...household.supermarkets.map((st) => st.name),
      ...items.map((it) => it.store).filter((st): st is string => Boolean(st)),
      ...storeSuggestions.values(),
    ])
  ).sort((a, b) => a.localeCompare(b));
  const storeColorMap = new Map(household.supermarkets.map((st) => [st.name, st.color]));

  const handleStoreChange = (item: ShoppingListItem, value: string) => {
    if (value === '__other__') {
      const typed = window.prompt('¿Dónde lo vas a comprar?', item.store ?? '');
      if (typed !== null) onSetStore(item.id, typed);
      return;
    }
    onSetStore(item.id, value || undefined);
  };

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
                — Escribe varios productos y, si quieres, dónde comprarlos
              </span>
            </div>
          </div>

          <button
            onClick={onOpenScanner}
            className="liquid-glass-subtle liquid-glass-interactive px-3 py-1 rounded-lg text-xs font-bold text-avocado-600 dark:text-avocado-400 flex items-center gap-1.5"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span className="sm:hidden">Escanear</span>
            <span className="hidden sm:inline">Escanear factura para autotachar</span>
          </button>
        </div>

        <form onSubmit={(e) => handleParseAndAdd(e)} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={nlInput}
            maxLength={MAX_SHOPPING_TEXT_CHARS}
            onChange={(e) => setNlInput(e.target.value)}
            placeholder='Ej.: 2 L de leche, pan y detergente'
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

        {stalled && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 space-y-2">
            <p className="text-xs font-semibold flex items-center gap-1.5 text-amber-800 dark:text-amber-200">
              <Clock className="w-3.5 h-3.5 shrink-0" />
              {stalled.reason === 'slow' ? 'La IA está tardando mucho.' : 'La IA no está disponible ahora.'}
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                onClick={handleQueueStalled}
                className="liquid-lens-btn px-3 py-1.5 rounded-lg text-xs font-bold"
              >
                Dejar en cola
              </button>
              <button
                type="button"
                onClick={handleManualStalled}
                className="liquid-glass-subtle liquid-glass-interactive px-3 py-1.5 rounded-lg text-xs font-bold"
              >
                Agregar sin IA
              </button>
            </div>
          </div>
        )}

        {queuedNotice && (
          <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">{queuedNotice}</p>
        )}

        {aiQuota && !aiQuota.exempt && (
          <p className={`text-[11px] ${aiAvailable ? 'text-[var(--text-muted)]' : 'text-amber-700 dark:text-amber-300 font-semibold'}`}>
            {describeAiQuota(aiQuota)}
            {!aiAvailable && ' Mientras tanto, la lista se separa por comas sin IA.'}
          </p>
        )}

        <div className="hidden sm:flex flex-wrap items-center gap-1.5">
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
                <span className="sm:hidden">Sugerencias</span>
                <span className="hidden sm:inline">Sugerencias de reposición (historial)</span>
              </h3>
            </div>
            <span className="hidden sm:inline text-[10px] text-[var(--text-muted)]">1 clic para añadir</span>
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

      {/* Active Shopping List Grouped by Place of Purchase: groups stretch to fill the row */}
      <div className="grid grid-cols-1 md:grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-3">
        {sortedStores.map((store) => {
          const storeItems = groupedByStore.get(store) || [];
          const color = storeColorMap.get(store) || (store ? '#4f7f27' : '#94a3b8');

          return (
            <div key={store || 'none'} className="liquid-glass rounded-xl p-3 space-y-2.5">
              <div className="flex items-center justify-between border-b border-[var(--glass-border)] pb-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <MapPin className="w-3.5 h-3.5 shrink-0" style={{ color }} />
                  <h3 className="text-xs font-bold truncate">
                    {store || (lang === 'en' ? 'No store yet' : 'Sin lugar definido')}
                  </h3>
                </div>
                <span className="text-[11px] font-bold text-[var(--text-muted)]">
                  {storeItems.length}
                </span>
              </div>

              <div className="space-y-1.5">
                {storeItems.map((item) => {
                  const creator = household.members.find((m) => m.id === item.createdBy);
                  const suggested = item.store ? undefined : suggestedStoreFor(storeSuggestions, item);
                  return (
                    <div
                      key={item.id}
                      className="liquid-glass-subtle rounded-lg px-2.5 py-2 flex items-center justify-between gap-2 group"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <button
                          onClick={() => onToggleItem(item.id)}
                          className="w-5 h-5 rounded border-2 border-avocado-500/60 hover:bg-avocado-500/20 flex items-center justify-center transition shrink-0"
                          aria-label={`Tachar ${item.name}`}
                        >
                          <Check className="w-3 h-3 opacity-0 group-hover:opacity-60 text-avocado-600" />
                        </button>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span
                              className="w-1.5 h-1.5 rounded-full shrink-0"
                              style={{ backgroundColor: categoryColorMap.get(item.category) || '#4f7f27' }}
                              title={translateCategory(item.category, lang)}
                            />
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
                          <label className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                            <MapPin className="w-2.5 h-2.5 shrink-0" />
                            <select
                              value={item.store ?? ''}
                              onChange={(e) => handleStoreChange(item, e.target.value)}
                              className="bg-transparent max-w-[9rem] truncate outline-none cursor-pointer"
                              aria-label={`Lugar de compra de ${item.name}`}
                            >
                              <option value="">
                                {suggested ? `${suggested} (más común)` : 'Elegir lugar…'}
                              </option>
                              {storeOptions.map((st) => (
                                <option key={st} value={st}>
                                  {st}
                                </option>
                              ))}
                              <option value="__other__">Otro…</option>
                            </select>
                          </label>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {creator && (
                          <Avatar name={creator.name} src={creator.avatarUrl} color={creator.accentColor} className="w-4 h-4" />
                        )}
                        <button
                          onClick={() => onDeleteItem(item.id)}
                          className="p-1 rounded opacity-50 hover:opacity-100 hover:bg-rose-500/15 text-rose-500 transition"
                          aria-label={`Eliminar ${item.name}`}
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

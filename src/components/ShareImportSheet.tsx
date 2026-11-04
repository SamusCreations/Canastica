import React, { useEffect, useMemo, useState } from 'react';
import { Check, ClipboardList, Home, Loader2, Plus, Trash2, X } from 'lucide-react';
import {
  ParsedShoppingInputItem,
  parseShoppingInputLocally,
  parseShoppingInputWithAI,
} from '../services/geminiAndSupabaseService';
import type { HouseholdMembership } from '../services/householdRepository';
import { normalizeReceiptProduct } from '../lib/restockEngine';
import { withAiTimeout } from '../lib/aiQueue';
import { chunkSharedLines, cleanSharedListLines } from '../lib/sharedText';
import { GroceryCategory, Household, ShoppingListItem } from '../types/grocery';
import { translateCategory } from '../utils/formatters';

interface Row extends ParsedShoppingInputItem {
  key: string;
  selected: boolean;
  duplicate: boolean;
}

interface ShareImportSheetProps {
  text: string;
  household: Household;
  householdId: string;
  memberships: HouseholdMembership[];
  existingItems: ShoppingListItem[];
  onAdd: (items: ParsedShoppingInputItem[]) => void;
  onSwitchHousehold: (id: string) => void;
  onClose: () => void;
}

const keyOf = (name: string) => name.trim().toLowerCase();

/** Preview of a list shared from WhatsApp (or pasted): edit, untick duplicates, then add. */
export const ShareImportSheet: React.FC<ShareImportSheetProps> = ({
  text,
  household,
  householdId,
  memberships,
  existingItems,
  onAdd,
  onSwitchHousehold,
  onClose,
}) => {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [usedAi, setUsedAi] = useState(true);
  const lang = household.language === 'en' ? 'en' : 'es';

  const pendingKeys = useMemo(
    () =>
      new Set(
        existingItems
          .filter((i) => !i.isChecked)
          .flatMap((i) => [keyOf(i.canonicalName || i.name), keyOf(i.name)])
      ),
    [existingItems]
  );

  useEffect(() => {
    let active = true;
    (async () => {
      const chunks = chunkSharedLines(cleanSharedListLines(text));
      const parsed: ParsedShoppingInputItem[] = [];
      let allAi = true;
      for (const chunk of chunks) {
        const timed = await withAiTimeout(parseShoppingInputWithAI(chunk, lang));
        const items = !timed.timedOut && timed.value && timed.value.length > 0 ? timed.value : null;
        if (!items) allAi = false;
        parsed.push(...(items ?? parseShoppingInputLocally(chunk)));
      }
      if (!active) return;
      setUsedAi(allAi && chunks.length > 0);
      setRows(
        parsed.map((it, i) => {
          const duplicate = pendingKeys.has(keyOf(it.canonicalName)) || pendingKeys.has(keyOf(it.name));
          return { ...it, key: `${i}-${it.name}`, selected: !duplicate, duplicate };
        })
      );
    })();
    return () => {
      active = false;
    };
    // Parse once per shared text; duplicates are re-marked below when the list changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, lang]);

  const update = (key: string, patch: Partial<Row>) =>
    setRows((prev) =>
      (prev ?? []).map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...patch };
        if (patch.name !== undefined) {
          const norm = normalizeReceiptProduct(patch.name);
          next.canonicalName = norm.canonicalName;
          next.duplicate = pendingKeys.has(keyOf(norm.canonicalName)) || pendingKeys.has(keyOf(patch.name));
        }
        return next;
      })
    );

  const selected = (rows ?? []).filter((r) => r.selected && r.name.trim());
  const categories = household.categories.map((c) => c.name);

  const handleAdd = () => {
    onAdd(
      selected.map(({ name, canonicalName, category, quantity, unit, store }) => ({
        name: name.trim(),
        canonicalName: canonicalName || name.trim(),
        category,
        quantity: quantity > 0 ? quantity : 1,
        unit: unit || 'unid',
        ...(store ? { store } : {}),
      }))
    );
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Agregar lista compartida"
        className="relative w-full sm:max-w-lg max-h-[90dvh] flex flex-col liquid-glass-elevated rounded-t-3xl sm:rounded-2xl animate-spring-in"
      >
        <div className="p-4 pb-2 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl liquid-lens-btn flex items-center justify-center text-white shrink-0">
            <ClipboardList className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-base font-bold">Agregar a la lista</p>
            <p className="text-xs text-[var(--text-muted)]">Revisa los productos antes de agregarlos.</p>
          </div>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-xl liquid-glass-subtle liquid-glass-interactive flex items-center justify-center shrink-0"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {memberships.length > 1 && (
          <label className="mx-4 mb-2 flex items-center gap-2 text-sm">
            <Home className="w-4 h-4 text-avocado-600 shrink-0" />
            <span className="text-[var(--text-muted)] shrink-0">Hogar:</span>
            <select
              value={householdId}
              onChange={(e) => onSwitchHousehold(e.target.value)}
              className="liquid-input flex-1 min-h-[40px] px-2 rounded-lg text-sm font-semibold"
            >
              {memberships.map((m) => (
                <option key={m.householdId} value={m.householdId}>
                  {m.householdName}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flex-1 overflow-y-auto px-4 space-y-2 pb-2">
          {rows === null ? (
            <div className="py-10 flex flex-col items-center gap-2 text-sm text-[var(--text-muted)]">
              <Loader2 className="w-5 h-5 animate-spin" /> Leyendo la lista…
            </div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--text-muted)]">No encontramos productos en el texto compartido.</p>
          ) : (
            <>
              {!usedAi && (
                <p className="text-[11px] text-amber-700 dark:text-amber-300 font-semibold">
                  La IA no respondió: separamos la lista por líneas. Revisa cantidades y categorías.
                </p>
              )}
              {rows.map((r) => (
                <div
                  key={r.key}
                  className={`rounded-xl p-2.5 space-y-2 ${r.selected ? 'liquid-glass' : 'liquid-glass-subtle opacity-60'}`}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={r.selected}
                      onClick={() => update(r.key, { selected: !r.selected })}
                      className={`w-7 h-7 rounded-lg border-2 flex items-center justify-center shrink-0 ${
                        r.selected ? 'bg-avocado-600 border-avocado-600 text-white' : 'border-slate-300 dark:border-slate-600'
                      }`}
                      aria-label={r.selected ? 'No agregar' : 'Agregar'}
                    >
                      {r.selected && <Check className="w-4 h-4" />}
                    </button>
                    <input
                      value={r.name}
                      onChange={(e) => update(r.key, { name: e.target.value })}
                      className="liquid-input flex-1 min-w-0 min-h-[40px] px-2.5 rounded-lg text-sm font-semibold"
                      aria-label="Producto"
                    />
                    <button
                      type="button"
                      onClick={() => setRows((prev) => (prev ?? []).filter((x) => x.key !== r.key))}
                      className="w-9 h-9 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-rose-600 shrink-0"
                      aria-label="Quitar"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex items-center gap-2 pl-9">
                    <input
                      type="number"
                      min={0}
                      step="any"
                      inputMode="decimal"
                      value={r.quantity}
                      onChange={(e) => update(r.key, { quantity: parseFloat(e.target.value) || 0 })}
                      className="liquid-input w-16 min-h-[36px] px-2 rounded-lg text-sm"
                      aria-label="Cantidad"
                    />
                    <input
                      value={r.unit}
                      onChange={(e) => update(r.key, { unit: e.target.value })}
                      className="liquid-input w-16 min-h-[36px] px-2 rounded-lg text-sm"
                      aria-label="Unidad"
                    />
                    <select
                      value={r.category}
                      onChange={(e) => update(r.key, { category: e.target.value as GroceryCategory })}
                      className="liquid-input flex-1 min-w-0 min-h-[36px] px-2 rounded-lg text-xs"
                      aria-label="Categoría"
                    >
                      {categories.map((c) => (
                        <option key={c} value={c}>
                          {translateCategory(c, lang)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {r.duplicate && (
                    <p className="pl-9 text-[11px] font-semibold text-amber-700 dark:text-amber-300">Ya está en la lista</p>
                  )}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="p-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+16px)] border-t border-[var(--glass-border)]">
          <button
            onClick={handleAdd}
            disabled={selected.length === 0}
            className="w-full min-h-[48px] rounded-xl liquid-lens-btn text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" /> Agregar {selected.length} {selected.length === 1 ? 'producto' : 'productos'}
          </button>
        </div>
      </div>
    </div>
  );
};

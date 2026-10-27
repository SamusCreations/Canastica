import React, { useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Calendar,
  CheckCircle2,
  Flame,
  Refrigerator,
  Snowflake,
  Sparkles,
} from 'lucide-react';
import { Household, PantryItem, StorageLocation } from '../types/grocery';
import { translateCategory, translateStorage } from '../utils/formatters';
import { getTodayIso } from '../utils/dates';
import { Avatar } from './Avatar';

interface PantryViewProps {
  household: Household;
  pantryItems: PantryItem[];
  onPantryFeedback: (
    pantryItemId: string,
    canonicalName: string,
    feedback: 'ran_out' | 'still_have_some'
  ) => void;
}

export const PantryView: React.FC<PantryViewProps> = ({
  household,
  pantryItems,
  onPantryFeedback,
}) => {
  const [selectedLocation, setSelectedLocation] = useState<'All' | StorageLocation>('All');
  const lang = household.language;
  const todayStr = getTodayIso();

  const getDaysUntilExpiry = (expiryDate: string) => {
    const a = new Date(`${todayStr}T00:00:00`).getTime();
    const b = new Date(`${expiryDate}T00:00:00`).getTime();
    return Math.round((b - a) / (1000 * 60 * 60 * 24));
  };

  const activeItems = pantryItems.filter((item) => item.status !== 'ran_out');
  const filteredItems =
    selectedLocation === 'All'
      ? activeItems
      : activeItems.filter((i) => i.storageLocation === selectedLocation);

  const expiringSoonItems = activeItems.filter(
    (i) => getDaysUntilExpiry(i.estimatedExpiryDate) <= 3
  );

  return (
    <div className="space-y-3.5">
      {/* Unified Minimalist Filter & Expiry Alert Bar */}
      <div className="liquid-glass rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
        {/* Left: Storage Location Filter Pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          {(['All', 'Fridge', 'Freezer', 'Dry Pantry', 'Household'] as const).map((loc) => (
            <button
              key={loc}
              onClick={() => setSelectedLocation(loc)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition ${
                selectedLocation === loc
                  ? 'liquid-lens-btn text-white'
                  : 'liquid-glass-subtle liquid-glass-interactive'
              }`}
            >
              {loc === 'Fridge' && <Refrigerator className="w-3.5 h-3.5" />}
              {loc === 'Freezer' && <Snowflake className="w-3.5 h-3.5" />}
              {loc === 'Dry Pantry' && <Archive className="w-3.5 h-3.5" />}
              {loc === 'Household' && <Sparkles className="w-3.5 h-3.5" />}
              <span>
                {loc === 'All' ? `Toda (${activeItems.length})` : translateStorage(loc, lang)}
              </span>
            </button>
          ))}
        </div>

        {/* Right: Inline Expiring Soon Alert Pills */}
        {expiringSoonItems.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" /> Por vencer (≤3d):
            </span>
            {expiringSoonItems.map((exp) => {
              const daysLeft = getDaysUntilExpiry(exp.estimatedExpiryDate);
              return (
                <span
                  key={exp.id}
                  className="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-800 dark:text-amber-200 border border-amber-500/30 text-[11px] font-semibold"
                >
                  {exp.name} ({daysLeft <= 0 ? 'Hoy' : `${daysLeft}d`})
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Pantry Items Grid (4 columns on desktop so all 8 items fit in 2 rows without scrolling!) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
        {filteredItems.map((item) => {
          const daysToExpiry = getDaysUntilExpiry(item.estimatedExpiryDate);
          const isExpiringSoon = daysToExpiry <= 3;
          const addedByMember = household.members.find((m) => m.id === item.addedBy);

          return (
            <div
              key={item.id}
              className={`liquid-glass rounded-xl p-3.5 flex flex-col justify-between gap-2.5 border ${
                isExpiringSoon ? 'border-amber-500/45' : 'border-[var(--glass-border)]'
              }`}
            >
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-[9px] font-bold uppercase px-1.5 py-0.2 rounded bg-slate-500/10 text-[var(--text-secondary)]">
                      {translateStorage(item.storageLocation, lang)} •{' '}
                      {translateCategory(item.category, lang)}
                    </span>
                    <h3 className="text-sm font-extrabold mt-1 truncate" title={item.name}>
                      {item.name}
                    </h3>
                    <p className="text-[11px] text-[var(--text-muted)] truncate">
                      {item.quantityLabel}
                    </p>
                  </div>
                  {addedByMember && (
                    <Avatar name={addedByMember.name} src={addedByMember.avatarUrl} color={addedByMember.accentColor} className="w-6 h-6" />
                  )}
                </div>

                {/* Compact Expiry Badge */}
                <div
                  className={`rounded-lg px-2.5 py-1.5 text-[11px] flex items-center justify-between ${
                    isExpiringSoon
                      ? 'bg-amber-500/15 text-amber-800 dark:text-amber-200 border border-amber-500/30'
                      : 'liquid-glass-subtle text-[var(--text-secondary)]'
                  }`}
                >
                  <span className="flex items-center gap-1 font-medium truncate">
                    <Calendar className="w-3 h-3 text-avocado-600 dark:text-avocado-400 shrink-0" />
                    Vence: {item.estimatedExpiryDate}
                  </span>
                  <span className="font-bold shrink-0 ml-1">
                    {daysToExpiry <= 0
                      ? 'Vencido'
                      : daysToExpiry <= 3
                      ? `¡${daysToExpiry}d!`
                      : `${daysToExpiry}d`}
                  </span>
                </div>

                {/* Remaining Stock Bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-[var(--text-muted)]">Reserva estimada</span>
                    <span className="font-bold text-avocado-600 dark:text-avocado-400">
                      {item.remainingPercentage}%
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        item.remainingPercentage <= 30 ? 'bg-amber-500' : 'bg-avocado-600'
                      }`}
                      style={{ width: `${item.remainingPercentage}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Quick User Feedback Buttons */}
              <div className="pt-2 border-t border-[var(--glass-border)] flex items-center justify-between gap-1.5">
                <button
                  onClick={() => onPantryFeedback(item.id, item.canonicalName, 'ran_out')}
                  className="flex-1 py-1 rounded-md text-[10px] font-bold bg-rose-500/12 hover:bg-rose-500/20 text-rose-700 dark:text-rose-300 flex items-center justify-center gap-1 transition"
                >
                  <Flame className="w-3 h-3" /> Se acabó
                </button>
                <button
                  onClick={() => onPantryFeedback(item.id, item.canonicalName, 'still_have_some')}
                  className="flex-1 py-1 rounded-md text-[10px] font-bold bg-emerald-500/12 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 flex items-center justify-center gap-1 transition"
                >
                  <CheckCircle2 className="w-3 h-3" /> Aún queda
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

import React, { useRef, useState } from 'react';
import { CheckCircle2, Paperclip, X } from 'lucide-react';
import type { CurrencyCode } from '../types/grocery';
import { formatCurrency } from '../utils/formatters';

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

export interface SettleDetails {
  note: string;
  evidence: File | null;
}

interface SettleSheetProps {
  fromName: string;
  toName: string;
  amount: number;
  currency: CurrencyCode;
  onCancel: () => void;
  onConfirm: (details: SettleDetails) => void;
}

/** Confirms a settlement with an optional note and proof of payment (photo or PDF). */
export const SettleSheet: React.FC<SettleSheetProps> = ({ fromName, toName, amount, currency, onCancel, onConfirm }) => {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState<File | null>(null);
  const [error, setError] = useState('');

  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/') && file.type !== 'application/pdf') {
      setError('Adjunta una foto o un PDF del comprobante.');
      return;
    }
    if (file.size > MAX_EVIDENCE_BYTES) {
      setError('El archivo es muy grande (máximo 8 MB).');
      return;
    }
    setError('');
    setEvidence(file);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Liquidar"
        className="relative liquid-glass-elevated w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl p-4 sm:p-5 space-y-4 pb-[calc(env(safe-area-inset-bottom)+16px)] animate-spring-in"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold">Liquidar {formatCurrency(amount, currency)}</h3>
            <p className="text-xs text-[var(--text-muted)]">
              {fromName.split(' ')[0]} le paga a {toName.split(' ')[0]}. Le enviaremos un correo a{' '}
              {toName.split(' ')[0]} avisándole.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="w-9 h-9 rounded-xl liquid-glass-subtle liquid-glass-interactive flex items-center justify-center shrink-0"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <label className="block space-y-1">
          <span className="text-xs font-semibold text-[var(--text-secondary)]">Nota (opcional)</span>
          <input
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Ej.: SINPE de octubre"
            className="liquid-input w-full px-3 py-2 rounded-xl text-sm"
          />
        </label>

        <div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          {evidence ? (
            <div className="liquid-glass-subtle rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-xs">
              <span className="truncate flex items-center gap-1.5">
                <Paperclip className="w-3.5 h-3.5 shrink-0" /> {evidence.name}
              </span>
              <button onClick={() => setEvidence(null)} className="text-rose-600 dark:text-rose-400 font-bold shrink-0">
                Quitar
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full min-h-[44px] rounded-xl border-2 border-dashed border-[var(--glass-border-strong)] text-sm font-semibold text-[var(--text-secondary)] flex items-center justify-center gap-2 hover:border-avocado-500/60"
            >
              <Paperclip className="w-4 h-4" /> Adjuntar comprobante (opcional)
            </button>
          )}
          {error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        </div>

        <button
          onClick={() => onConfirm({ note: note.trim(), evidence })}
          className="w-full liquid-lens-btn min-h-[48px] rounded-xl text-base font-bold flex items-center justify-center gap-2"
        >
          <CheckCircle2 className="w-4 h-4" /> Confirmar liquidación
        </button>
      </div>
    </div>
  );
};

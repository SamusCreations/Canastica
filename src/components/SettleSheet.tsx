import React, { useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, HandCoins, Paperclip, X } from 'lucide-react';
import type { CurrencyCode } from '../types/grocery';
import { formatCurrency } from '../utils/formatters';
import { Sheet } from './ui/Sheet';
import { Button, Field, FormActions, TextInput } from './ui/Form';

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
  const from = fromName.split(' ')[0];
  const to = toName.split(' ')[0];

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
    <Sheet
      onClose={onCancel}
      title="Liquidar saldo"
      icon={<HandCoins className="w-5 h-5" />}
      size="sm"
      zIndex="z-[80]"
      footer={
        <FormActions>
          <Button variant="secondary" size="lg" onClick={onCancel}>
            Cancelar
          </Button>
          <Button size="lg" onClick={() => onConfirm({ note: note.trim(), evidence })}>
            <CheckCircle2 className="w-5 h-5" /> Registrar pago
          </Button>
        </FormActions>
      }
    >
      <div className="space-y-5">
        <div className="rounded-2xl bg-[var(--glass-bg-subtle)] p-4 text-center">
          <p className="text-sm text-[var(--text-secondary)] flex items-center justify-center gap-2 font-medium">
            {from} <ArrowRight className="w-4 h-4" /> {to}
          </p>
          <p className="text-4xl font-bold tracking-tight mt-1 tabular-nums">{formatCurrency(amount, currency)}</p>
          <p className="text-xs text-[var(--text-muted)] mt-1">Le avisaremos a {to} por correo.</p>
        </div>

        <Field label="Nota (opcional)">
          {(id) => (
            <TextInput
              id={id}
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ej.: SINPE de octubre"
              enterKeyHint="done"
            />
          )}
        </Field>

        <Field label="Comprobante (opcional)" error={error || undefined} hint="Foto o PDF, máximo 8 MB.">
          {() => (
            <>
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
                <div className="min-h-12 rounded-xl border border-[var(--input-border)] px-3.5 flex items-center justify-between gap-2 text-sm">
                  <span className="truncate flex items-center gap-2">
                    <Paperclip className="w-4 h-4 shrink-0 text-avocado-600" /> {evidence.name}
                  </span>
                  <button
                    onClick={() => setEvidence(null)}
                    className="w-9 h-9 -mr-2 rounded-full flex items-center justify-center text-[var(--text-muted)] hover:text-coral-500"
                    aria-label="Quitar comprobante"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="w-full min-h-12 rounded-xl border-2 border-dashed border-[var(--glass-border-strong)] text-sm font-semibold text-[var(--text-secondary)] flex items-center justify-center gap-2 hover:border-avocado-400"
                >
                  <Paperclip className="w-4 h-4" /> Adjuntar comprobante
                </button>
              )}
            </>
          )}
        </Field>
      </div>
    </Sheet>
  );
};

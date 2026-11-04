import React from 'react';
import { AlertTriangle, FileText, Inbox, Loader2 } from 'lucide-react';
import type { InboundInvoice } from '../services/inboundInvoicesService';
import { CurrencyCode } from '../types/grocery';
import { formatCurrency } from '../utils/formatters';

interface InboundInvoicesCardProps {
  invoices: InboundInvoice[];
  currency: CurrencyCode;
  busyId: string | null;
  onReview: (invoice: InboundInvoice) => void;
  onOpenPdf: (invoice: InboundInvoice) => void;
  onDiscard: (invoice: InboundInvoice) => void;
  onOpenSettings: () => void;
}

const dateFormat = new Intl.DateTimeFormat('es-CR', { dateStyle: 'medium' });

/** Dashboard tray: invoices received by email waiting for approval. */
export const InboundInvoicesCard: React.FC<InboundInvoicesCardProps> = ({
  invoices,
  currency,
  busyId,
  onReview,
  onOpenPdf,
  onDiscard,
  onOpenSettings,
}) => {
  const pending = invoices.filter((i) => i.status === 'pending');
  const errors = invoices.filter((i) => i.status === 'error');
  const confirmation = invoices.find((i) => i.status === 'confirmation' && i.confirmationCode);
  if (pending.length === 0 && !confirmation && errors.length === 0) return null;

  return (
    <div className="liquid-glass rounded-xl p-3.5 space-y-2.5 mb-3.5 animate-spring-in">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
          <Inbox className="w-3.5 h-3.5" /> Facturas por revisar {pending.length > 0 && `(${pending.length})`}
        </h3>
        <button onClick={onOpenSettings} className="text-[11px] font-semibold text-avocado-700 dark:text-avocado-400">
          Ajustes
        </button>
      </div>

      {confirmation && (
        <button
          onClick={onOpenSettings}
          className="w-full text-left rounded-lg px-3 py-2 bg-avocado-600/10 border border-avocado-600/30 text-xs"
        >
          Gmail envió un código para confirmar el reenvío: <strong>{confirmation.confirmationCode}</strong>
        </button>
      )}

      <ul className="space-y-1.5">
        {pending.slice(0, 8).map((inv) => (
          <li key={inv.id} className="liquid-glass-subtle rounded-lg px-3 py-2 flex items-center gap-2">
            <FileText className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate">{inv.issuer || inv.subject || inv.sender || 'Factura'}</p>
              <p className="text-[11px] text-[var(--text-muted)]">
                {inv.total != null && `${formatCurrency(inv.total, currency)} · `}
                {dateFormat.format(new Date(inv.issuedAt ? `${inv.issuedAt}T12:00:00` : inv.receivedAt))}
                {!inv.xmlPath && inv.pdfPath && ' · solo PDF'}
              </p>
            </div>
            {inv.xmlPath ? (
              <button
                onClick={() => onReview(inv)}
                disabled={busyId === inv.id}
                className="min-h-[36px] px-3 rounded-lg liquid-lens-btn text-xs font-bold flex items-center gap-1 shrink-0"
              >
                {busyId === inv.id && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Revisar
              </button>
            ) : (
              <button
                onClick={() => onOpenPdf(inv)}
                className="min-h-[36px] px-3 rounded-lg liquid-glass liquid-glass-interactive text-xs font-bold shrink-0"
              >
                Ver PDF
              </button>
            )}
            <button
              onClick={() => onDiscard(inv)}
              className="min-h-[36px] px-2 rounded-lg text-xs font-semibold text-[var(--text-muted)] hover:text-rose-600 shrink-0"
            >
              Descartar
            </button>
          </li>
        ))}
      </ul>

      {errors.length > 0 && (
        <p className="text-[11px] text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          {errors.length === 1 ? 'Un correo reenviado' : `${errors.length} correos reenviados`} no traía una factura electrónica válida.
        </p>
      )}
    </div>
  );
};

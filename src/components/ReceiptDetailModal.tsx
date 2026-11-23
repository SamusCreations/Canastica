import React, { useState } from 'react';
import { receiptFileKind } from '../utils/receiptFile';
import { ChevronDown, FileText, Pencil, Store, Trash2 } from 'lucide-react';
import { CurrencyCode, HouseholdMember, Purchase } from '../types/grocery';
import { formatCurrency } from '../utils/formatters';
import { InboundFile } from '../services/inboundInvoicesService';
import { InvoiceFilesList } from './InvoiceFilesList';
import { Sheet } from './ui/Sheet';
import { Button } from './ui/Form';

interface ReceiptDetailModalProps {
  purchase: Purchase | null;
  members: HouseholdMember[];
  currency: CurrencyCode;
  onClose: () => void;
  onEdit?: (purchase: Purchase) => void;
  onDelete?: (purchase: Purchase) => void;
  /** Original files of the email invoice the purchase was imported from */
  invoiceFiles?: InboundFile[];
  onOpenInvoiceFile?: (file: InboundFile, download: boolean) => void;
}

/** Read-only purchase detail with edit / delete. One scroll area; photo collapses on phones. */
export const ReceiptDetailModal: React.FC<ReceiptDetailModalProps> = ({
  purchase,
  members,
  currency,
  onClose,
  onEdit,
  onDelete,
  invoiceFiles,
  onOpenInvoiceFile,
}) => {
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  if (!purchase) return null;
  const confirmingDelete = confirmingDeleteId === purchase.id;

  const buyer = members.find((m) => m.id === purchase.createdBy);
  // Costa Rican receipts usually print prices with IVA already included
  const taxesIncluded =
    purchase.taxes > 0 &&
    (purchase.notes?.includes('IVA incluido') || Math.abs(purchase.subtotal - purchase.discounts - purchase.totalAmount) <= 2);
  const kind = purchase.receiptImageUrl ? receiptFileKind(purchase.receiptImageUrl) : null;

  const photo = (
    <div className="rounded-2xl bg-[var(--glass-bg-subtle)] border border-[var(--glass-border)] p-2 flex flex-col items-center gap-2">
      {purchase.receiptImageUrl && kind !== 'image' ? (
        <a
          href={purchase.receiptImageUrl}
          target="_blank"
          rel="noreferrer"
          className="py-8 flex flex-col items-center gap-2 text-sm font-semibold text-avocado-700 dark:text-avocado-300"
        >
          <FileText className="w-10 h-10" />
          {kind === 'xml' ? 'Abrir factura electrónica (XML)' : 'Abrir factura en PDF'}
        </a>
      ) : purchase.receiptImageUrl ? (
        <a href={purchase.receiptImageUrl} target="_blank" rel="noreferrer" title="Abrir la foto completa">
          <img
            src={purchase.receiptImageUrl}
            alt={`Factura ${purchase.supermarket}`}
            className="max-w-full max-h-[60vh] object-contain rounded-xl"
          />
        </a>
      ) : (
        <p className="py-8 text-sm text-[var(--text-muted)]">Sin imagen de la factura</p>
      )}
      {invoiceFiles && invoiceFiles.length > 0 && onOpenInvoiceFile && (
        <div className="w-full px-1 pb-1">
          <p className="text-xs font-semibold text-[var(--text-secondary)]">Archivos originales del correo</p>
          <InvoiceFilesList files={invoiceFiles} onOpen={onOpenInvoiceFile} />
        </div>
      )}
    </div>
  );

  return (
    <Sheet
      onClose={onClose}
      title={purchase.supermarket}
      subtitle={`${purchase.purchaseDate} · pagó ${buyer?.name.split(' ')[0] || 'un miembro'}`}
      icon={<Store className="w-5 h-5" />}
      size="lg"
      footer={
        confirmingDelete && onDelete ? (
          <div className="space-y-3">
            <p className="text-sm">
              ¿Eliminar esta compra de <strong>{formatCurrency(purchase.totalAmount, currency)}</strong>? No se puede deshacer.
            </p>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <Button variant="secondary" size="lg" onClick={() => setConfirmingDeleteId(null)}>
                Cancelar
              </Button>
              <Button
                size="lg"
                className="!bg-coral-500 hover:!bg-coral-400"
                onClick={() => {
                  setConfirmingDeleteId(null);
                  onDelete(purchase);
                }}
              >
                <Trash2 className="w-4 h-4" /> Sí, eliminar
              </Button>
            </div>
          </div>
        ) : onEdit || onDelete ? (
          <div className="flex gap-2">
            {onDelete && (
              <Button variant="danger" size="lg" onClick={() => setConfirmingDeleteId(purchase.id)} aria-label="Eliminar compra">
                <Trash2 className="w-5 h-5" />
                <span className="hidden sm:inline">Eliminar</span>
              </Button>
            )}
            {onEdit && (
              <Button size="lg" className="flex-1 sm:flex-none sm:ml-auto" onClick={() => onEdit(purchase)}>
                <Pencil className="w-4 h-4" /> Editar compra
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="md:grid md:grid-cols-[minmax(0,260px)_minmax(0,1fr)] md:gap-6 md:items-start space-y-4 md:space-y-0">
        <aside className="hidden md:block md:sticky md:top-0">{photo}</aside>

        <div className="space-y-4 min-w-0">
          {(purchase.receiptImageUrl || (invoiceFiles && invoiceFiles.length > 0)) && (
            <details className="md:hidden group rounded-2xl border border-[var(--glass-border)]">
              <summary className="list-none cursor-pointer min-h-12 px-4 flex items-center justify-between text-sm font-semibold">
                <span className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-avocado-600" /> Ver la factura original
                </span>
                <ChevronDown className="w-4 h-4 text-[var(--text-muted)] transition group-open:rotate-180" />
              </summary>
              <div className="px-2 pb-2">{photo}</div>
            </details>
          )}

          <section>
            <h3 className="text-sm font-bold mb-1">Productos ({purchase.items.length})</h3>
            <ul className="divide-y divide-[var(--glass-border)]">
              {purchase.items.map((item) => {
                const owner = item.isShared ? null : members.find((m) => m.id === (item.assignedTo ?? purchase.createdBy));
                return (
                  <li key={item.id} className="py-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[15px] font-medium truncate">{item.normalizedName}</p>
                      <p className="text-xs text-[var(--text-muted)]">
                        {item.quantity} {item.unit} · {formatCurrency(item.unitPrice, currency)} c/u
                        {owner ? ` · de ${owner.name.split(' ')[0]}` : ''}
                      </p>
                    </div>
                    <span className="text-[15px] font-semibold tabular-nums shrink-0">{formatCurrency(item.totalPrice, currency)}</span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="rounded-2xl bg-[var(--glass-bg-subtle)] p-4 space-y-2 text-sm">
            <div className="flex justify-between text-[var(--text-secondary)]">
              <span>Subtotal</span>
              <span className="tabular-nums">{formatCurrency(purchase.subtotal, currency)}</span>
            </div>
            {purchase.discounts > 0 && (
              <div className="flex justify-between text-avocado-700 dark:text-avocado-300">
                <span>Descuentos</span>
                <span className="tabular-nums">−{formatCurrency(purchase.discounts, currency)}</span>
              </div>
            )}
            <div className="flex justify-between text-[var(--text-secondary)]">
              <span>{taxesIncluded ? 'IVA (incluido)' : 'IVA'}</span>
              <span className="tabular-nums">
                {taxesIncluded ? '' : '+'}
                {formatCurrency(purchase.taxes, currency)}
              </span>
            </div>
            <div className="flex justify-between text-base font-bold pt-2 border-t border-[var(--glass-border)]">
              <span>Total</span>
              <span className="tabular-nums">{formatCurrency(purchase.totalAmount, currency)}</span>
            </div>
          </section>
        </div>
      </div>
    </Sheet>
  );
};

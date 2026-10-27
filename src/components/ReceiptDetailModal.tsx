import React, { useState } from 'react';
import { Calendar, Pencil, Store, Tag, Trash2, User, Users, X } from 'lucide-react';
import { CurrencyCode, HouseholdMember, Purchase } from '../types/grocery';
import { formatCurrency } from '../utils/formatters';
import { Avatar } from './Avatar';

interface ReceiptDetailModalProps {
  purchase: Purchase | null;
  members: HouseholdMember[];
  currency: CurrencyCode;
  onClose: () => void;
  onEdit?: (purchase: Purchase) => void;
  onDelete?: (purchase: Purchase) => void;
}

export const ReceiptDetailModal: React.FC<ReceiptDetailModalProps> = ({
  purchase,
  members,
  currency,
  onClose,
  onEdit,
  onDelete,
}) => {
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  if (!purchase) return null;
  const confirmingDelete = confirmingDeleteId === purchase.id;

  const buyer = members.find((m) => m.id === purchase.createdBy);
  // Costa Rican receipts usually print prices with IVA already included
  const taxesIncluded =
    purchase.taxes > 0 &&
    (purchase.notes?.includes('IVA incluido') ||
      Math.abs(purchase.subtotal - purchase.discounts - purchase.totalAmount) <= 2);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-md animate-spring-in">
      <div className="liquid-glass-elevated w-full max-w-4xl rounded-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--glass-border)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl liquid-glass-subtle flex items-center justify-center text-avocado-600 dark:text-avocado-400">
              <Store className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold">{purchase.supermarket} — Factura Registrada</h3>
              <p className="text-xs text-[var(--text-muted)] flex items-center gap-2">
                <Calendar className="w-3.5 h-3.5" /> {purchase.purchaseDate} • Pagado por{' '}
                {buyer?.name || 'Miembro del Hogar'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onEdit && (
              <button
                onClick={() => onEdit(purchase)}
                className="px-3 py-2 rounded-xl liquid-glass liquid-glass-interactive text-xs font-bold flex items-center gap-1.5"
              >
                <Pencil className="w-4 h-4" /> <span className="hidden sm:inline">Editar factura</span>
              </button>
            )}
            {onDelete && (
              <button
                onClick={() => setConfirmingDeleteId(purchase.id)}
                className="px-3 py-2 rounded-xl liquid-glass liquid-glass-interactive text-xs font-bold flex items-center gap-1.5 text-rose-600 dark:text-rose-400"
              >
                <Trash2 className="w-4 h-4" /> <span className="hidden sm:inline">Eliminar</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-xl liquid-glass liquid-glass-interactive"
              aria-label="Cerrar"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {confirmingDelete && onDelete && (
          <div className="mx-6 mt-4 p-4 rounded-xl border border-rose-500/40 bg-rose-500/10 flex flex-col sm:flex-row sm:items-center gap-3 animate-spring-in">
            <p className="text-xs text-rose-700 dark:text-rose-300 flex-1">
              ¿Eliminar la factura de <strong>{purchase.supermarket}</strong> del {purchase.purchaseDate} por{' '}
              <strong>{formatCurrency(purchase.totalAmount, currency)}</strong>? Esta acción no se puede deshacer.
            </p>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => setConfirmingDeleteId(null)}
                className="px-3 py-2 rounded-lg liquid-glass liquid-glass-interactive text-xs font-semibold"
              >
                Cancelar
              </button>
              <button
                onClick={() => {
                  setConfirmingDeleteId(null);
                  onDelete(purchase);
                }}
                className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold"
              >
                Sí, eliminar
              </button>
            </div>
          </div>
        )}

        <div className="p-6 overflow-y-auto grid grid-cols-1 md:grid-cols-12 gap-6">
          {/* Original Stored Receipt Image */}
          <div className="md:col-span-5 liquid-glass-subtle rounded-xl p-3 flex flex-col items-center">
            <span className="text-xs font-semibold text-[var(--text-secondary)] mb-2">
              Imagen Original de la Factura
            </span>
            {purchase.receiptImageUrl ? (
              <img
                src={purchase.receiptImageUrl}
                alt={`Factura ${purchase.supermarket}`}
                className="max-w-full h-auto rounded-lg shadow-sm"
              />
            ) : (
              <p className="py-10 text-xs text-[var(--text-muted)]">Sin imagen de la factura</p>
            )}
          </div>

          {/* Itemized Breakdown */}
          <div className="md:col-span-7 flex flex-col justify-between space-y-4">
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold">
                  Productos Normalizados ({purchase.items.length})
                </h4>
                {buyer && (
                  <div className="flex items-center gap-2 px-3 py-1 rounded-full liquid-glass-subtle text-xs font-semibold">
                    <Avatar name={buyer.name} src={buyer.avatarUrl} color={buyer.accentColor} className="w-4 h-4" />
                    <span>{buyer.name}</span>
                  </div>
                )}
              </div>

              <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
                {purchase.items.map((item) => (
                  <div
                    key={item.id}
                    className="liquid-glass-subtle rounded-xl p-3 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs truncate">
                          {item.normalizedName}
                        </span>
                        <span
                          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 ${
                            item.isShared
                              ? 'bg-avocado-500/15 text-avocado-600 dark:text-avocado-400'
                              : 'bg-purple-500/15 text-purple-600 dark:text-purple-400'
                          }`}
                        >
                          {item.isShared ? (
                            <>
                              <Users className="w-2.5 h-2.5" /> Compartido
                            </>
                          ) : (
                            <>
                              <User className="w-2.5 h-2.5" /> Personal
                            </>
                          )}
                        </span>
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)] flex flex-wrap items-center gap-2 mt-0.5">
                        <span className="font-mono text-[10px]">
                          Factura: {item.rawReceiptName}
                        </span>
                        <span>•</span>
                        <span className="flex items-center gap-1 text-avocado-600 dark:text-avocado-400 font-medium">
                          <Tag className="w-3 h-3" /> {item.canonicalName}
                        </span>
                        <span>•</span>
                        <span>
                          {item.quantity} {item.unit} ({item.baseUnitQuantity.toLocaleString('es-CR')}{' '}
                          {item.baseUnit})
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-extrabold text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(item.totalPrice, currency)}
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)]">
                        {formatCurrency(item.unitPrice, currency)} / {item.unit === 'kg' ? 'kg' : 'unid'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="liquid-glass-subtle rounded-xl p-4 space-y-1.5 text-xs">
              <div className="flex justify-between text-[var(--text-secondary)]">
                <span>Subtotal</span>
                <span>{formatCurrency(purchase.subtotal, currency)}</span>
              </div>
              <div className="flex justify-between text-emerald-600 dark:text-emerald-400 font-medium">
                <span>Descuentos</span>
                <span>−{formatCurrency(purchase.discounts, currency)}</span>
              </div>
              <div className="flex justify-between text-[var(--text-secondary)]">
                <span>{taxesIncluded ? 'IVA (incluido en los precios)' : 'Impuestos (IVA)'}</span>
                <span>
                  {taxesIncluded ? '' : '+'}
                  {formatCurrency(purchase.taxes, currency)}
                </span>
              </div>
              <div className="flex justify-between text-sm font-extrabold pt-2 border-t border-[var(--glass-border)] text-avocado-600 dark:text-avocado-400">
                <span>Total General</span>
                <span>{formatCurrency(purchase.totalAmount, currency)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

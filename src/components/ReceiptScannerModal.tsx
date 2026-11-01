import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clock,
  FileText,
  FileWarning,
  Plus,
  RefreshCw,
  Sparkles,
  Store,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  normalizeReceiptProduct,
  normalizeToBaseUnit,
  describeAiQuota,
  getSupabaseClient,
  scanReceiptImageWithAI,
  type ScannedReceiptResult,
} from '../services/geminiAndSupabaseService';
import {
  askNotificationPermission,
  enqueueAiRequest,
  removeAiQueueEntry,
  updateAiQueueEntry,
  withAiTimeout,
} from '../lib/aiQueue';
import { useAiQuota } from '../lib/useAiQuota';
import { openReportProblem } from '../lib/reportProblem';
import {
  CurrencyCode,
  GroceryCategory,
  HouseholdMember,
  LanguageCode,
  Purchase,
  PurchaseItem,
  SupermarketStore,
  SupermarketType,
} from '../types/grocery';
import { formatCurrency, translateCategory } from '../utils/formatters';
import { getTodayIso } from '../utils/dates';
import { applyReceiptMemory, buildReceiptMemory } from '../lib/receiptMemory';
import { AssigneeSelect } from './AssigneeSelect';
import { isElectronicInvoiceFile, parseElectronicInvoiceXml } from '../lib/electronicInvoice';
import { receiptFileKind } from '../utils/receiptFile';

interface EditableDraftItem {
  id: string;
  rawReceiptName: string;
  normalizedName: string;
  canonicalName: string;
  category: GroceryCategory;
  quantity: number;
  unit: string;
  unitPrice: number;
  grossPrice: number;      // line amount before the item's promo
  discount: number;        // promo attached to this item (positive)
  discountLabel?: string | null;
  totalPrice: number;      // what was actually paid for the line (gross - discount)
  barcode?: string | null;
  pricingMode?: 'unit' | 'multi' | 'weight';
  needsReview?: boolean;
  reviewReasons?: string[];
  learnedFromHistory?: boolean;
  isShared: boolean;
  assignedTo?: string;
}

interface ReceiptScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  members: HouseholdMember[];
  currentMemberId: string;
  categories: GroceryCategory[];
  supermarkets: SupermarketStore[];
  currency: CurrencyCode;
  language: LanguageCode;
  purchaseHistory?: Purchase[];
  onCreateSupermarket: (store: Omit<SupermarketStore, 'id'>) => void;
  onSavePurchase: (purchase: Purchase) => void;
  /** When set, the modal opens on the confirmation step to edit this saved receipt */
  editingPurchase?: Purchase | null;
  onUpdatePurchase?: (purchase: Purchase) => void;
  /** Household the AI queue entries belong to */
  householdId?: string;
  /** A queued receipt the AI already read: the modal opens on its review step */
  queuedScan?: { id: string; dataUrl: string; result: ScannedReceiptResult } | null;
  /** Called after a queued receipt is saved */
  onQueuedScanSaved?: (queueId: string) => void;
}

type DateSource = 'printed' | 'clave' | 'none';

function purchaseToDraftItems(purchase: Purchase): EditableDraftItem[] {
  return purchase.items.map((it) => ({
    id: it.id,
    rawReceiptName: it.rawReceiptName,
    normalizedName: it.normalizedName,
    canonicalName: it.canonicalName,
    category: it.category,
    quantity: it.quantity,
    unit: it.unit,
    unitPrice: it.unitPrice,
    // Saved lines keep only the net amount, so any promo is already inside it
    grossPrice: it.totalPrice,
    discount: 0,
    totalPrice: it.totalPrice,
    isShared: it.isShared,
    assignedTo: it.assignedTo,
  }));
}

/** Receipt-level discount = all discounts minus the per-item promos folded into the line totals. */
function receiptLevelDiscount(purchase: Purchase): number {
  const lineTotals = purchase.items.reduce((s, it) => s + it.totalPrice, 0);
  const itemPromos = Math.max(0, purchase.subtotal - lineTotals);
  return Math.max(0, Math.round(purchase.discounts - itemPromos));
}

function purchaseHasTaxIncluded(purchase: Purchase): boolean {
  return (
    purchase.taxes === 0 ||
    Boolean(purchase.notes?.includes('IVA incluido')) ||
    Math.abs(purchase.subtotal - purchase.discounts - purchase.totalAmount) <= 2
  );
}

export const ReceiptScannerModal: React.FC<ReceiptScannerModalProps> = ({
  isOpen,
  onClose,
  members,
  currentMemberId,
  categories,
  supermarkets,
  currency,
  language,
  purchaseHistory = [],
  onCreateSupermarket,
  onSavePurchase,
  editingPurchase = null,
  onUpdatePurchase,
  householdId = '',
  queuedScan = null,
  onQueuedScanSaved,
}) => {
  const isEditing = Boolean(editingPurchase);
  const aiQuota = useAiQuota();
  const aiAvailable = !aiQuota || aiQuota.exempt || aiQuota.remaining > 0;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  const [step, setStep] = useState<'upload' | 'scanning' | 'blurry_error' | 'ai_unavailable' | 'queued' | 'confirm'>(
    editingPurchase ? 'confirm' : 'upload'
  );
  const [aiUnavailableReason, setAiUnavailableReason] = useState<'slow' | 'down'>('slow');
  // Scan still running after the time limit: its result is used if the user is still waiting
  const lateScanRef = useRef<{ dataUrl: string; queueId: string | null; waiting: boolean } | null>(null);
  const [scanStageText, setScanStageText] = useState('Leyendo tu factura…');
  const [blurryAdvice, setBlurryAdvice] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  // Confirmation card editable fields
  const [supermarket, setSupermarket] = useState(
    editingPurchase?.supermarket ?? supermarkets[0]?.name ?? ''
  );
  const [purchaseDate, setPurchaseDate] = useState(editingPurchase?.purchaseDate ?? getTodayIso());
  const [dateSource, setDateSource] = useState<DateSource>('printed');
  const [paidByMemberId, setPaidByMemberId] = useState(editingPurchase?.createdBy ?? currentMemberId);
  const [discounts, setDiscounts] = useState(editingPurchase ? receiptLevelDiscount(editingPurchase) : 0);
  const [taxes, setTaxes] = useState(editingPurchase?.taxes ?? 0);
  const [receiptGrandTotal, setReceiptGrandTotal] = useState(editingPurchase?.totalAmount ?? 0);
  const [taxesIncluded, setTaxesIncluded] = useState(
    editingPurchase ? purchaseHasTaxIncluded(editingPurchase) : true
  );
  const [scanWarnings, setScanWarnings] = useState<string[]>([]);
  const [wasRepaired, setWasRepaired] = useState(false);
  const [receiptImageUrl, setReceiptImageUrl] = useState(editingPurchase?.receiptImageUrl ?? '');
  const [failedImageUrl, setFailedImageUrl] = useState('');
  const [draftItems, setDraftItems] = useState<EditableDraftItem[]>(
    editingPurchase ? purchaseToDraftItems(editingPurchase) : []
  );

  // Inline custom supermarket creator
  const [showNewStoreForm, setShowNewStoreForm] = useState(false);
  const [newStoreName, setNewStoreName] = useState('');
  const [newStoreType, setNewStoreType] = useState<SupermarketType>('Abastecedor / Pulpería');
  const [newStoreLocation, setNewStoreLocation] = useState('');

  // A receipt the queue already read opens straight on its review
  useEffect(() => {
    if (queuedScan) applyScanResult(queuedScan.result, queuedScan.dataUrl);
    // Only once per queued receipt (the modal is keyed by it)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isOpen) return null;

  const runSimulatedScanSequence = async (callback: () => Promise<void> | void) => {
    setStep('scanning');
    setScanStageText('Leyendo tu factura…');
    await callback();
  };

  const handleFileUpload = (file: File) => {
    // Hacienda electronic invoice XML: read exactly, no AI needed
    if (isElectronicInvoiceFile(file)) {
      file.text().then((xml) => {
        const parsed = parseElectronicInvoiceXml(xml);
        if (!parsed) {
          setBlurryAdvice('Este archivo XML no parece una factura electrónica. Sube el XML de la factura (no el de la respuesta de Hacienda), un PDF o una foto.');
          setFailedImageUrl('');
          setStep('blurry_error');
          return;
        }
        const bytes = new TextEncoder().encode(xml);
        let binary = '';
        bytes.forEach((b) => (binary += String.fromCharCode(b)));
        applyScanResult(parsed, `data:application/xml;base64,${btoa(binary)}`);
      });
      return;
    }
    if (!file.type.startsWith('image/') && file.type !== 'application/pdf') {
      setBlurryAdvice('Ese tipo de archivo no se puede leer. Usa una foto, un PDF o el XML de la factura electrónica.');
      setFailedImageUrl('');
      setStep('blurry_error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      runSimulatedScanSequence(async () => {
        lateScanRef.current = null;
        const timed = await withAiTimeout(scanReceiptImageWithAI(dataUrl, language));
        if (timed.timedOut) {
          // Too slow: offer the queue or manual entry, but keep listening for the answer
          const pending = { dataUrl, queueId: null as string | null, waiting: true };
          lateScanRef.current = pending;
          setFailedImageUrl(dataUrl);
          setAiUnavailableReason('slow');
          setStep('ai_unavailable');
          timed.late.then((late) => {
            const ok = !late.isBlurry && !late.aiUnavailable;
            if (pending.queueId) {
              if (ok) updateAiQueueEntry(pending.queueId, { status: 'ready', result: late });
            } else if (pending.waiting && lateScanRef.current === pending) {
              lateScanRef.current = null;
              if (ok) applyScanResult(late, dataUrl);
            }
          });
          return;
        }
        const result = timed.value;
        if (result.aiUnavailable) {
          setFailedImageUrl(dataUrl);
          setBlurryAdvice(result.blurryAdvice || '');
          setAiUnavailableReason('down');
          setStep('ai_unavailable');
          return;
        }
        applyScanResult(result, dataUrl);
      });
    };
    reader.readAsDataURL(file);
  };

  const handleQueueReceipt = () => {
    const dataUrl = failedImageUrl;
    if (!dataUrl) return;
    const entry = enqueueAiRequest({ kind: 'receipt', householdId, dataUrl, language: language === 'en' ? 'en' : 'es' });
    if (!entry) {
      setBlurryAdvice('La cola ya tiene muchas facturas esperando. Regístrala a mano o inténtalo más tarde.');
      setStep('blurry_error');
      return;
    }
    if (lateScanRef.current) {
      lateScanRef.current.queueId = entry.id;
      lateScanRef.current.waiting = false;
    }
    askNotificationPermission();
    setStep('queued');
  };

  const handleManualInsteadOfWaiting = () => {
    if (lateScanRef.current) lateScanRef.current.waiting = false;
    lateScanRef.current = null;
    handleEnterManually();
  };

  function applyScanResult(result: ScannedReceiptResult, dataUrl: string) {
    if (result.isBlurry) {
      setBlurryAdvice(
        result.blurryAdvice ||
          'El texto del recibo se ve desenfocado. Mantén el teléfono firme y evita sombras.'
      );
      setFailedImageUrl(dataUrl);
      setStep('blurry_error');
      return;
    }
    // "PALI SARCHI" on the receipt -> the household's "Palí" store
    const fold = (v: string) =>
      v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const scannedStore = fold(result.supermarket || '');
    const knownStore = scannedStore
      ? supermarkets.find((st) => {
          const name = fold(st.name);
          return name === scannedStore || scannedStore.startsWith(`${name} `) || name.startsWith(`${scannedStore} `);
        })
      : undefined;
    setSupermarket(knownStore?.name || result.supermarket || supermarkets[0]?.name || '');
    // No printed date and no electronic key: default to today and ask the user to confirm
    const source: DateSource = result.purchaseDate ? result.dateSource ?? 'printed' : 'none';
    setDateSource(source);
    setPurchaseDate(source === 'none' ? getTodayIso() : result.purchaseDate);
    setDiscounts(result.discounts || 0);
    setTaxes(result.taxes || 0);
    setTaxesIncluded(result.pricesIncludeTax ?? true);
    setReceiptGrandTotal(result.receiptTotal || 0);
    setScanWarnings(result.validation?.warnings ?? []);
    setWasRepaired(Boolean(result.validation?.repaired));
    setReceiptImageUrl(dataUrl);
    const memory = buildReceiptMemory(purchaseHistory);
    setDraftItems(
      result.items.map((it, idx) =>
        applyReceiptMemory(
          {
            id: `draft-up-${Date.now()}-${idx}`,
            rawReceiptName: it.rawReceiptName,
            normalizedName: it.normalizedName,
            canonicalName: it.canonicalName,
            category: it.category,
            quantity: it.quantity,
            unit: it.unit,
            unitPrice: it.unitPrice,
            grossPrice: it.grossPrice ?? it.totalPrice,
            discount: it.discount ?? 0,
            discountLabel: it.discountLabel,
            totalPrice: it.totalPrice,
            barcode: it.barcode,
            pricingMode: it.pricingMode,
            sizeKnown: it.sizeKnown,
            needsReview: it.needsReview,
            reviewReasons: it.reviewReasons,
            isShared: it.isShared,
          },
          memory
        )
      ).map((d) =>
        d.learnedFromHistory && d.sizeKnown
          ? {
              ...d,
              reviewReasons: d.reviewReasons?.filter((r) => !r.startsWith('La factura no indica')),
            }
          : d
      )
    );
    setStep('confirm');
  }

  const itemsSubtotal = Math.round(
    draftItems.reduce((sum, item) => sum + (Number(item.totalPrice) || 0), 0)
  );
  const itemPromos = Math.round(
    draftItems.reduce((sum, item) => sum + (Number(item.discount) || 0), 0)
  );
  const computedGrandTotal = Math.round(itemsSubtotal - discounts + (taxesIncluded ? 0 : taxes));
  const reviewCount = draftItems.filter((i) => i.needsReview).length;
  const totalDifference = Math.round(computedGrandTotal - receiptGrandTotal);
  const hasMathDiscrepancy = Math.abs(totalDifference) > 1;

  const handleUpdateDraftItem = (
    id: string,
    field: keyof EditableDraftItem,
    value: string | number | boolean
  ) => {
    setDraftItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, [field]: value };
        if (field === 'quantity' || field === 'unitPrice') {
          const q = field === 'quantity' ? Number(value) : item.quantity;
          const up = field === 'unitPrice' ? Number(value) : item.unitPrice;
          updated.grossPrice = Math.round(q * up);
          updated.totalPrice = Math.max(0, updated.grossPrice - (Number(item.discount) || 0));
        }
        if (field === 'discount') {
          updated.totalPrice = Math.max(0, item.grossPrice - (Number(value) || 0));
        }
        if (field === 'totalPrice') {
          updated.grossPrice = (Number(value) || 0) + (Number(item.discount) || 0);
        }
        if (field !== 'isShared') updated.needsReview = false;
        if (field === 'normalizedName' && typeof value === 'string') {
          const norm = normalizeReceiptProduct(value);
          updated.canonicalName = norm.canonicalName;
        }
        return updated;
      })
    );
  };

  const handleAddManualDraftItem = () => {
    setDraftItems((prev) => [
      ...prev,
      {
        id: `draft-manual-${Date.now()}`,
        rawReceiptName: 'MANUAL',
        normalizedName: '',
        canonicalName: '',
        category: 'Pantry Staples',
        quantity: 1,
        unit: 'unid',
        unitPrice: 0,
        grossPrice: 0,
        discount: 0,
        totalPrice: 0,
        isShared: true,
      },
    ]);
  };

  // Plan B when the AI is down: keep the photo and type the items by hand
  const handleEnterManually = () => {
    setPurchaseDate(getTodayIso());
    setDateSource('none');
    setDiscounts(0);
    setTaxes(0);
    setTaxesIncluded(true);
    setReceiptGrandTotal(0);
    setScanWarnings([]);
    setWasRepaired(false);
    setReceiptImageUrl(failedImageUrl);
    setDraftItems([]);
    setStep('confirm');
  };

  const handleCreateCustomStoreInline = () => {
    const trimmed = newStoreName.trim();
    if (!trimmed) return;
    onCreateSupermarket({
      name: trimmed,
      type: newStoreType,
      color: '#0284c7',
      locationHint: newStoreLocation.trim() || 'Comercio Local',
      isCustom: true,
    });
    setSupermarket(trimmed);
    setNewStoreName('');
    setNewStoreLocation('');
    setShowNewStoreForm(false);
  };

  const handleConfirmAndSave = () => {
    // Also register supermarket if user typed one not in list
    if (
      supermarket.trim() &&
      !supermarkets.some((s) => s.name.toLowerCase() === supermarket.trim().toLowerCase())
    ) {
      onCreateSupermarket({
        name: supermarket.trim(),
        type: 'Abastecedor / Pulpería',
        color: '#0284c7',
        isCustom: true,
      });
    }

    const purchaseId = editingPurchase?.id ?? `pur-${Date.now()}`;
    const finalItems: PurchaseItem[] = draftItems.map((d, idx) => {
      const baseConv = normalizeToBaseUnit(d.quantity, d.unit, d.normalizedName);
      return {
        id: `pi-${Date.now()}-${idx}`,
        purchaseId,
        rawReceiptName: d.rawReceiptName,
        normalizedName: d.normalizedName,
        canonicalName: d.canonicalName || normalizeReceiptProduct(d.normalizedName).canonicalName,
        category: d.category,
        quantity: Number(d.quantity),
        unit: d.unit,
        baseUnitQuantity: baseConv.baseUnitQuantity,
        baseUnit: baseConv.baseUnit,
        unitPrice: Number(d.unitPrice),
        totalPrice: Number(d.totalPrice),
        isShared: d.isShared,
        assignedTo: d.isShared ? undefined : d.assignedTo ?? paidByMemberId,
        createdBy: paidByMemberId,
        purchaseDate,
        supermarket,
      };
    });

    // Purchase keeps the classic breakdown: gross subtotal - all discounts (+ IVA only when not included)
    const grossSubtotal = itemsSubtotal + itemPromos;
    const allDiscounts = itemPromos + Number(discounts);
    const newPurchase: Purchase = {
      id: purchaseId,
      householdId: editingPurchase?.householdId ?? '',
      supermarket,
      purchaseDate,
      createdBy: paidByMemberId,
      subtotal: grossSubtotal,
      discounts: allDiscounts,
      taxes: Number(taxes),
      totalAmount: Number(receiptGrandTotal),
      notes: taxesIncluded && Number(taxes) > 0 ? 'IVA incluido en los precios' : undefined,
      receiptImageUrl,
      items: finalItems,
    };

    if (editingPurchase && onUpdatePurchase) {
      onUpdatePurchase(newPurchase);
    } else {
      onSavePurchase(newPurchase);
      if (queuedScan) {
        removeAiQueueEntry(queuedScan.id);
        onQueuedScanSaved?.(queuedScan.id);
      }
    }
    setStep('upload');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-slate-900/50 backdrop-blur-md animate-spring-in overflow-hidden">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEditing ? 'Editar factura' : 'Escáner de facturas'}
        className="liquid-glass-elevated w-full max-w-6xl rounded-t-3xl sm:rounded-2xl overflow-hidden h-[calc(100dvh-env(safe-area-inset-top)-8px)] sm:h-auto sm:max-h-[90vh] flex flex-col"
      >
        {/* Top Modal Header */}
        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-[var(--glass-border)] shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl liquid-lens-btn flex items-center justify-center text-white shrink-0">
              <Camera className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold tracking-tight flex items-center gap-2 truncate">
                {isEditing
                  ? language === 'es' ? 'Editar factura' : 'Edit receipt'
                  : language === 'es' ? 'Escanear factura' : 'Scan receipt'}
              </h2>
              <p className="hidden sm:block text-xs text-[var(--text-muted)]">
                {isEditing
                  ? 'Corrige comercio, fecha, productos o montos y guarda los cambios'
                  : `Lectura automática de productos y total en ${currency}`}
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              setStep('upload');
              onClose();
            }}
            className="w-10 h-10 shrink-0 flex items-center justify-center rounded-xl liquid-glass liquid-glass-interactive"
            aria-label="Cerrar escáner"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div
          className={`px-4 pt-4 sm:px-6 sm:pt-6 overflow-y-auto overscroll-contain flex-1 space-y-6 ${
            step === 'confirm' ? 'pb-[env(safe-area-inset-bottom)]' : 'pb-[calc(env(safe-area-inset-bottom)+16px)]'
          }`}
        >
          {step === 'upload' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Drag and Drop / Mobile Camera Zone */}
              <div className="lg:col-span-12 flex flex-col justify-between">
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                    const file = e.dataTransfer.files?.[0];
                    if (file) handleFileUpload(file);
                  }}
                  className={`liquid-glass-subtle rounded-2xl p-8 text-center border-2 border-dashed transition-all flex flex-col items-center justify-center min-h-[300px] ${
                    isDragging
                      ? 'border-avocado-500 bg-avocado-500/10'
                      : 'border-[var(--glass-border-strong)] hover:border-avocado-500/60'
                  }`}
                >
                  <div className="w-14 h-14 rounded-2xl liquid-lens-btn flex items-center justify-center text-white mb-4">
                    <Upload className="w-7 h-7" />
                  </div>
                  <h3 className="text-base font-bold mb-1">
                    <span className="sm:hidden">Sube o toma la foto de tu factura</span>
                    <span className="hidden sm:inline">Arrastra y suelta la foto de tu factura, o tómala con la cámara</span>
                  </h3>
                  <p className="hidden sm:block text-xs text-[var(--text-muted)] max-w-md mb-6 leading-relaxed">
                    Lectura automática de tiquetes de cualquier supermercado o pulpería: traduce códigos abreviados como{' '}
                    <code className="px-1.5 py-0.5 rounded bg-avocado-500/10 font-mono text-avocado-600 dark:text-avocado-400">
                      LCH DOS PIN 1L
                    </code>{' '}
                    en{' '}
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                      Leche Dos Pinos 1L
                    </span>
                    .
                  </p>

                  <div className="flex flex-wrap items-center justify-center gap-3">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*,application/pdf,.pdf,.xml,text/xml,application/xml"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleFileUpload(f);
                      }}
                    />
                    <input
                      ref={cameraInputRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleFileUpload(f);
                      }}
                    />
                    <button
                      onClick={() => cameraInputRef.current?.click()}
                      disabled={!aiAvailable}
                      className="liquid-lens-btn px-5 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 disabled:opacity-50"
                    >
                      <Camera className="w-4 h-4" />
                      Tomar Foto con Cámara
                    </button>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="liquid-glass liquid-glass-interactive px-5 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2"
                    >
                      <Upload className="w-4 h-4 text-avocado-600 dark:text-avocado-400" />
                      Subir foto, PDF o XML
                    </button>
                    <button
                      onClick={handleEnterManually}
                      className="liquid-glass-subtle liquid-glass-interactive px-5 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      Registrar sin Escanear
                    </button>
                  </div>
                  {aiQuota && !aiQuota.exempt && (
                    <p
                      className={`mt-4 text-[11px] ${
                        aiAvailable ? 'text-[var(--text-muted)]' : 'text-amber-700 dark:text-amber-300 font-semibold'
                      }`}
                    >
                      {describeAiQuota(aiQuota)}
                      {!aiAvailable && ' Puedes registrar la factura a mano.'}
                    </p>
                  )}
                </div>
              </div>

            </div>
          )}

          {/* Glass Shimmer Skeleton State while AI processes */}
          {step === 'scanning' && (
            <div className="py-10 px-4 flex flex-col items-center justify-center space-y-6">
              <div className="w-14 h-14 rounded-2xl liquid-lens-btn flex items-center justify-center text-white">
                <Sparkles className="w-7 h-7 animate-spin" />
              </div>
              <div className="text-center space-y-1">
                <h3 className="text-base font-bold">{scanStageText}</h3>
                <p className="text-xs text-[var(--text-muted)]">
                  Esto puede tardar unos segundos.
                </p>
              </div>
              <div className="w-full max-w-3xl grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="h-44 rounded-xl liquid-skeleton" />
                <div className="md:col-span-2 space-y-3">
                  <div className="h-10 rounded-xl liquid-skeleton" />
                  <div className="h-11 rounded-xl liquid-skeleton" />
                  <div className="h-11 rounded-xl liquid-skeleton" />
                  <div className="h-11 rounded-xl liquid-skeleton" />
                </div>
              </div>
            </div>
          )}

          {/* AI too slow or unavailable: queue it or type it by hand */}
          {step === 'ai_unavailable' && (
            <div className="max-w-xl mx-auto liquid-glass rounded-2xl p-6 border border-amber-500/40 text-center space-y-4">
              <div className="w-12 h-12 rounded-xl bg-amber-500/15 flex items-center justify-center mx-auto text-amber-600 dark:text-amber-400">
                <Clock className="w-6 h-6" />
              </div>
              <h3 className="text-base font-bold">
                {aiUnavailableReason === 'slow' ? 'La IA está tardando mucho' : 'La IA no está disponible ahora'}
              </h3>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                {aiUnavailableReason === 'slow'
                  ? 'Puedes dejar la factura en cola y te avisamos cuando esté lista para revisar, o registrarla a mano.'
                  : blurryAdvice || 'Puedes dejar la factura en cola o registrarla a mano.'}
              </p>
              <div className="flex flex-col sm:flex-row items-stretch justify-center gap-3 pt-2">
                <button
                  onClick={handleQueueReceipt}
                  className="liquid-lens-btn px-5 py-2.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2"
                >
                  <Clock className="w-4 h-4" />
                  Dejar en cola
                </button>
                <button
                  onClick={handleManualInsteadOfWaiting}
                  className="liquid-glass-subtle liquid-glass-interactive px-5 py-2.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Registrar a mano
                </button>
              </div>
              {aiUnavailableReason === 'slow' && (
                <p className="text-[11px] text-[var(--text-muted)]">Si la IA responde mientras decides, se abre sola.</p>
              )}
            </div>
          )}

          {step === 'queued' && (
            <div className="max-w-xl mx-auto liquid-glass rounded-2xl p-6 border border-emerald-500/40 text-center space-y-4">
              <CheckCircle2 className="w-12 h-12 mx-auto text-emerald-500" />
              <h3 className="text-base font-bold">Factura en cola</h3>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                La leeremos cuando la IA esté disponible y te avisaremos para que la revises antes de guardarla.
                Puedes seguir agregando más facturas.
              </p>
              <div className="flex flex-col sm:flex-row items-stretch justify-center gap-3">
                <button
                  onClick={() => setStep('upload')}
                  className="liquid-glass-subtle liquid-glass-interactive px-5 py-2.5 rounded-xl text-sm font-bold"
                >
                  Escanear otra
                </button>
                <button
                  onClick={() => {
                    setStep('upload');
                    onClose();
                  }}
                  className="liquid-lens-btn px-5 py-2.5 rounded-xl text-sm font-bold"
                >
                  Listo
                </button>
              </div>
            </div>
          )}

          {/* Friendly Blurry / Unreadable Receipt Recovery UI */}
          {step === 'blurry_error' && (
            <div className="max-w-xl mx-auto liquid-glass rounded-2xl p-6 border border-rose-500/40 text-center space-y-4">
              <div className="w-12 h-12 rounded-xl bg-rose-500/15 flex items-center justify-center mx-auto text-rose-600 dark:text-rose-400">
                <FileWarning className="w-6 h-6" />
              </div>
              <h3 className="text-base font-bold">No Pudimos Leer Esta Factura con Claridad</h3>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{blurryAdvice}</p>
              <div className="liquid-glass-subtle rounded-xl p-4 text-left text-xs space-y-1.5">
                <p className="font-bold text-avocado-600 dark:text-avocado-400">
                  Consejos para una Foto Nítida:
                </p>
                <ul className="list-disc list-inside text-[var(--text-secondary)] space-y-1">
                  <li>Alisa las arrugas del papel térmico sobre una mesa plana.</li>
                  <li>Usa buena luz sin sombras sobre la columna de precios.</li>
                  <li>Asegúrate de que se vean tanto los nombres a la izquierda como los montos a la derecha.</li>
                </ul>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <button
                  onClick={() => setStep('upload')}
                  className="liquid-lens-btn px-5 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2"
                >
                  <RefreshCw className="w-4 h-4" />
                  Volver a Intentar / Elegir Otra Foto
                </button>
                {getSupabaseClient() && (
                  <button
                    onClick={() =>
                      openReportProblem({ prefill: `Error al escanear una factura: "${blurryAdvice}"

` })
                    }
                    className="liquid-glass-subtle liquid-glass-interactive px-5 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 text-rose-600 dark:text-rose-400"
                  >
                    <FileWarning className="w-4 h-4" />
                    Reportar este Problema
                  </button>
                )}
                {failedImageUrl && (
                  <button
                    onClick={handleEnterManually}
                    className="liquid-glass-subtle liquid-glass-interactive px-5 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2"
                  >
                    <Plus className="w-4 h-4" />
                    Registrar a Mano con Esta Foto
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Glass Confirmation Card (Side-by-Side Receipt Image + Editable Items) */}
          {step === 'confirm' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Left Side: Original Receipt Image Preview */}
              <div className="lg:col-span-4 flex flex-col gap-3">
                <div className="liquid-glass rounded-xl p-3 flex flex-col items-center">
                  <div className="w-full flex items-center justify-between text-xs font-semibold px-2 pb-2 text-[var(--text-secondary)]">
                    <span>Imagen Original de Factura</span>
                    <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Lista para Guardar
                    </span>
                  </div>
                  <div className="w-full max-h-64 overflow-hidden lg:max-h-[410px] lg:overflow-y-auto rounded-lg bg-slate-100 dark:bg-slate-900/60 p-2 flex justify-center">
                    {receiptImageUrl && receiptFileKind(receiptImageUrl) !== 'image' ? (
                      <a
                        href={receiptImageUrl}
                        target="_blank"
                        rel="noreferrer"
                        download={receiptFileKind(receiptImageUrl) === 'xml' ? 'factura.xml' : 'factura.pdf'}
                        className="py-10 flex flex-col items-center gap-2 text-xs font-semibold text-avocado-700 dark:text-avocado-300"
                      >
                        <FileText className="w-10 h-10" />
                        {receiptFileKind(receiptImageUrl) === 'xml' ? 'Factura electrónica (XML)' : 'Factura en PDF'}
                      </a>
                    ) : receiptImageUrl ? (
                      <img
                        src={receiptImageUrl}
                        alt="Factura escaneada"
                        className="max-w-full h-auto rounded-lg shadow-sm"
                      />
                    ) : (
                      <p className="py-10 text-xs text-[var(--text-muted)]">Sin imagen de la factura</p>
                    )}
                  </div>
                </div>

                {/* Sum Validation Status Card */}
                {hasMathDiscrepancy ? (
                  <div className="liquid-glass rounded-xl p-4 border border-amber-500/50 bg-amber-500/10 space-y-2.5">
                    <div className="flex items-start gap-2.5">
                      <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                      <div>
                        <h4 className="text-xs font-bold text-amber-700 dark:text-amber-300 uppercase">
                          Diferencia Detectada en Suma ({totalDifference > 0 ? '+' : ''}
                          {formatCurrency(totalDifference, currency)})
                        </h4>
                        <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
                          La suma calculada ({formatCurrency(itemsSubtotal, currency)} −{' '}
                          {formatCurrency(discounts, currency)} desc.
                          {taxesIncluded ? ', IVA incluido' : <> + {formatCurrency(taxes, currency)} IVA</>} ={' '}
                          <strong>{formatCurrency(computedGrandTotal, currency)}</strong>) no
                          coincide con el Total General de la factura (
                          <strong>{formatCurrency(receiptGrandTotal, currency)}</strong>). Revisa
                          los ítems o ajusta el total.
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setReceiptGrandTotal(computedGrandTotal)}
                      className="w-full py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-800 dark:text-amber-200 text-xs font-bold transition"
                    >
                      Ajustar Total General a {formatCurrency(computedGrandTotal, currency)}
                    </button>
                  </div>
                ) : (
                  <div className="liquid-glass rounded-xl p-3.5 border border-emerald-500/40 bg-emerald-500/10 flex items-center gap-2.5">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <div className="text-xs">
                      <p className="font-bold text-emerald-700 dark:text-emerald-300">
                        Suma de Ítems Validada Exactamente
                      </p>
                      <p className="text-[var(--text-secondary)]">
                        Productos ({formatCurrency(itemsSubtotal, currency)})
                        {discounts > 0 && <> − Desc. ({formatCurrency(discounts, currency)})</>}
                        {taxesIncluded ? ' (IVA incluido)' : <> + IVA ({formatCurrency(taxes, currency)})</>} ={' '}
                        <strong>{formatCurrency(receiptGrandTotal, currency)}</strong>
                      </p>
                      {itemPromos > 0 && (
                        <p className="text-[var(--text-secondary)]">
                          Ya incluye {formatCurrency(itemPromos, currency)} de promociones aplicadas a cada producto.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {(scanWarnings.length > 0 || reviewCount > 0 || wasRepaired) && (
                  <div className="liquid-glass rounded-xl p-3.5 border border-amber-500/30 space-y-1.5 text-xs">
                    {wasRepaired && (
                      <p className="flex items-start gap-1.5 text-[var(--text-secondary)]">
                        <RefreshCw className="w-3.5 h-3.5 shrink-0 mt-0.5 text-avocado-600 dark:text-avocado-400" />
                        La primera lectura no cuadraba con el total; se hizo una segunda lectura automática.
                      </p>
                    )}
                    {scanWarnings
                      .filter((w) => !w.startsWith('La suma'))
                      .map((w) => (
                        <p key={w} className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {w}
                        </p>
                      ))}
                    {reviewCount > 0 && (
                      <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        {reviewCount === 1
                          ? '1 producto marcado para revisar.'
                          : `${reviewCount} productos marcados para revisar.`}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Right Side: Editable Metadata & Line Items */}
              <div className="lg:col-span-8 flex flex-col gap-4">
                {/* Store, Date & Buyer Metadata */}
                <div className="liquid-glass rounded-xl p-4 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                    <div className="sm:col-span-2">
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[11px] font-semibold uppercase text-[var(--text-muted)]">
                          Supermercado / Comercio
                        </label>
                        <button
                          type="button"
                          onClick={() => setShowNewStoreForm((s) => !s)}
                          className="text-[11px] font-bold text-avocado-600 dark:text-avocado-400 hover:underline flex items-center gap-0.5"
                        >
                          <Plus className="w-3 h-3" /> Nuevo Comercio
                        </button>
                      </div>
                      <select
                        value={supermarket}
                        onChange={(e) => setSupermarket(e.target.value)}
                        className="liquid-input w-full px-3 py-2 rounded-lg text-xs font-semibold"
                      >
                        {supermarkets.map((st) => (
                          <option key={st.id} value={st.name}>
                            {st.name} ({st.type})
                          </option>
                        ))}
                        {!supermarkets.some((s) => s.name === supermarket) && (
                          <option value={supermarket}>{supermarket}</option>
                        )}
                      </select>
                    </div>
                    <div>
                      <label className="text-[11px] font-semibold uppercase text-[var(--text-muted)] block mb-1">
                        Fecha de Compra
                      </label>
                      <input
                        type="date"
                        value={purchaseDate}
                        max={getTodayIso()}
                        onChange={(e) => {
                          setPurchaseDate(e.target.value);
                          setDateSource('printed');
                        }}
                        className={`liquid-input w-full px-3 py-2 rounded-lg text-xs font-semibold ${
                          dateSource === 'none' ? 'ring-2 ring-amber-500/70 bg-amber-500/10' : ''
                        }`}
                      />
                      {dateSource === 'none' && (
                        <p className="mt-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                          La factura no trae fecha: confírmala
                        </p>
                      )}
                      {dateSource === 'clave' && (
                        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                          Fecha tomada de la clave electrónica
                        </p>
                      )}
                    </div>
                    <div>
                      <label className="text-[11px] font-semibold uppercase text-[var(--text-muted)] block mb-1">
                        Pagado Por
                      </label>
                      <select
                        value={paidByMemberId}
                        onChange={(e) => setPaidByMemberId(e.target.value)}
                        className="liquid-input w-full px-3 py-2 rounded-lg text-xs font-semibold"
                      >
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Inline Custom Supermarket Creator */}
                  {showNewStoreForm && (
                    <div className="liquid-glass-subtle rounded-xl p-3 border border-avocado-500/30 space-y-2 animate-spring-in">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-avocado-600 dark:text-avocado-400 flex items-center gap-1.5">
                          <Store className="w-3.5 h-3.5" /> Registrar Nuevo Supermercado o Pulpería Local
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowNewStoreForm(false)}
                          className="text-xs text-[var(--text-muted)]"
                        >
                          Cancelar
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <input
                          type="text"
                          value={newStoreName}
                          onChange={(e) => setNewStoreName(e.target.value)}
                          placeholder="Ej. Abastecedor La Amistad"
                          className="liquid-input px-3 py-1.5 rounded-lg text-xs"
                        />
                        <select
                          value={newStoreType}
                          onChange={(e) => setNewStoreType(e.target.value as SupermarketType)}
                          className="liquid-input px-2.5 py-1.5 rounded-lg text-xs"
                        >
                          <option value="Abastecedor / Pulpería">Abastecedor / Pulpería</option>
                          <option value="Feria del Agricultor">Feria del Agricultor</option>
                          <option value="Carnicería / Especialidad">Carnicería / Especialidad</option>
                          <option value="Cadena Nacional">Cadena Nacional</option>
                          <option value="Club Mayorista">Club Mayorista</option>
                          <option value="Otro">Otro Comercio</option>
                        </select>
                        <div className="flex gap-1.5">
                          <input
                            type="text"
                            value={newStoreLocation}
                            onChange={(e) => setNewStoreLocation(e.target.value)}
                            placeholder="Zona / Barrio (Opcional)"
                            className="liquid-input flex-1 px-2.5 py-1.5 rounded-lg text-xs"
                          />
                          <button
                            type="button"
                            onClick={handleCreateCustomStoreInline}
                            className="liquid-lens-btn px-3 py-1.5 rounded-lg text-xs font-bold shrink-0"
                          >
                            Guardar
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Extracted Items Table */}
                <div className="liquid-glass rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-bold">
                        Productos ({draftItems.length})
                      </h4>
                      <p className="hidden sm:block text-[11px] text-[var(--text-muted)]">
                        Puedes editar nombres, categorías, cantidades o precios antes de guardar.
                      </p>
                    </div>
                    <button
                      onClick={handleAddManualDraftItem}
                      className="liquid-glass liquid-glass-interactive px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 text-avocado-600 dark:text-avocado-400"
                    >
                      <Plus className="w-3.5 h-3.5" /> Añadir Ítem Manual
                    </button>
                  </div>

                  <div className="space-y-2 lg:max-h-[420px] lg:overflow-y-auto lg:pr-1">
                    {draftItems.map((item) => (
                      <div
                        key={item.id}
                        className={`liquid-glass-subtle rounded-xl p-3 flex flex-col gap-2 ${
                          item.needsReview ? 'ring-1 ring-amber-500/60' : ''
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                            <span className="px-2 py-0.5 rounded bg-slate-500/10 font-mono text-[var(--text-secondary)]">
                              Tiquete: {item.rawReceiptName}
                              {item.barcode && (
                                <span className="opacity-60"> · {item.barcode}</span>
                              )}
                            </span>
                            <span className="text-avocado-600 dark:text-avocado-400 font-semibold flex items-center gap-1">
                              → Producto: <Tag className="w-3 h-3" /> {item.canonicalName}
                            </span>
                            {item.pricingMode === 'weight' && (
                              <span className="px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-700 dark:text-sky-300 font-bold text-[10px]">
                                Por peso
                              </span>
                            )}
                            {item.learnedFromHistory && (
                              <span
                                className="px-1.5 py-0.5 rounded-full bg-avocado-500/15 text-avocado-700 dark:text-avocado-300 font-bold text-[10px]"
                                title="Nombre y presentación tomados de una compra anterior con la misma línea de factura"
                              >
                                Reconocido
                              </span>
                            )}
                            {item.needsReview && (
                              <span
                                className="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 font-bold text-[10px] flex items-center gap-1"
                                title={item.reviewReasons?.join(' ')}
                              >
                                <AlertTriangle className="w-3 h-3" /> Revisar
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <AssigneeSelect
                              members={members}
                              isShared={item.isShared}
                              assignedTo={item.assignedTo ?? paidByMemberId}
                              onChange={(value) =>
                                setDraftItems((prev) =>
                                  prev.map((d) =>
                                    d.id !== item.id
                                      ? d
                                      : value === 'shared'
                                        ? { ...d, isShared: true, assignedTo: undefined }
                                        : { ...d, isShared: false, assignedTo: value }
                                  )
                                )
                              }
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setDraftItems((prev) => prev.filter((i) => i.id !== item.id))
                              }
                              className="p-1 rounded-lg hover:bg-rose-500/15 text-rose-500 transition"
                              title="Eliminar ítem"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <label className="sm:col-span-2 flex flex-col gap-0.5">
                            <span className="text-[10px] font-semibold text-[var(--text-muted)]">Producto</span>
                            <input
                              type="text"
                              value={item.normalizedName}
                              onChange={(e) =>
                                handleUpdateDraftItem(item.id, 'normalizedName', e.target.value)
                              }
                              className="liquid-input w-full px-2.5 py-2 rounded-lg text-sm font-semibold"
                            />
                          </label>
                          <label className="sm:col-span-2 flex flex-col gap-0.5">
                            <span className="text-[10px] font-semibold text-[var(--text-muted)]">Categoría</span>
                            <select
                              value={item.category}
                              onChange={(e) =>
                                handleUpdateDraftItem(
                                  item.id,
                                  'category',
                                  e.target.value as GroceryCategory
                                )
                              }
                              className="liquid-input w-full px-2.5 py-2 rounded-lg text-sm"
                            >
                              {categories.map((cat) => (
                                <option key={cat} value={cat}>
                                  {translateCategory(cat, language)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="flex flex-col gap-0.5">
                            <span className="text-[10px] font-semibold text-[var(--text-muted)]">Cantidad</span>
                            <input
                              type="number"
                              step="any"
                              inputMode="decimal"
                              value={item.quantity}
                              onChange={(e) =>
                                handleUpdateDraftItem(
                                  item.id,
                                  'quantity',
                                  parseFloat(e.target.value) || 0
                                )
                              }
                              className="liquid-input w-full px-2.5 py-2 rounded-lg text-sm"
                            />
                          </label>
                          <label className="flex flex-col gap-0.5">
                            <span className="text-[10px] font-semibold text-[var(--text-muted)]">Unidad</span>
                            <input
                              type="text"
                              value={item.unit}
                              onChange={(e) =>
                                handleUpdateDraftItem(item.id, 'unit', e.target.value)
                              }
                              className="liquid-input w-full px-2.5 py-2 rounded-lg text-sm"
                            />
                          </label>
                          <label className="flex flex-col gap-0.5">
                            <span className="text-[10px] font-semibold text-[var(--text-muted)]">Precio unitario (₡)</span>
                            <input
                              type="number"
                              step="10"
                              inputMode="decimal"
                              value={item.unitPrice}
                              onChange={(e) =>
                                handleUpdateDraftItem(
                                  item.id,
                                  'unitPrice',
                                  parseFloat(e.target.value) || 0
                                )
                              }
                              className="liquid-input w-full px-2.5 py-2 rounded-lg text-sm text-right"
                            />
                          </label>
                          <label className="flex flex-col gap-0.5">
                            <span className="text-[10px] font-semibold text-[var(--text-muted)]">Total pagado (₡)</span>
                            <input
                              type="number"
                              step="10"
                              inputMode="decimal"
                              value={item.totalPrice}
                              onChange={(e) =>
                                handleUpdateDraftItem(
                                  item.id,
                                  'totalPrice',
                                  parseFloat(e.target.value) || 0
                                )
                              }
                              className="liquid-input w-full px-2.5 py-2 rounded-lg text-sm font-bold text-right text-emerald-600 dark:text-emerald-400"
                              title="Pagado por la línea, ya con la promoción (₡)"
                            />
                          </label>
                        </div>

                        {(item.discount > 0 || (item.reviewReasons?.length ?? 0) > 0) && (
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                            <span className="text-[var(--text-muted)]">
                              {item.reviewReasons?.join(' ')}
                            </span>
                            {item.discount > 0 && (
                              <label className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300 font-semibold">
                                {item.discountLabel || 'Promoción'}: −₡
                                <input
                                  type="number"
                                  step="10"
                                  value={item.discount}
                                  onChange={(e) =>
                                    handleUpdateDraftItem(
                                      item.id,
                                      'discount',
                                      parseFloat(e.target.value) || 0
                                    )
                                  }
                                  className="liquid-input w-20 px-1.5 py-1 rounded-lg text-xs text-right"
                                />
                                <span className="text-[var(--text-muted)] font-normal">
                                  (antes {formatCurrency(item.grossPrice, currency)})
                                </span>
                              </label>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Subtotal, Discounts, Taxes & Grand Total Row */}
                  <div className="pt-3 border-t border-[var(--glass-border)] grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="liquid-glass-subtle rounded-lg p-2.5">
                      <span className="text-[10px] uppercase text-[var(--text-muted)] block">
                        Productos (con promos)
                      </span>
                      <span className="text-sm font-bold">
                        {formatCurrency(itemsSubtotal, currency)}
                      </span>
                    </div>
                    <div className="liquid-glass-subtle rounded-lg p-2.5">
                      <span className="text-[10px] uppercase text-[var(--text-muted)] block">
                        Otros descuentos (−₡)
                      </span>
                      <input
                        type="number"
                        step="50"
                        value={discounts}
                        onChange={(e) => setDiscounts(parseFloat(e.target.value) || 0)}
                        className="bg-transparent font-bold text-sm text-emerald-600 dark:text-emerald-400 w-full focus:outline-none"
                      />
                    </div>
                    <div className="liquid-glass-subtle rounded-lg p-2.5">
                      <span className="text-[10px] uppercase text-[var(--text-muted)] block">
                        <span className="flex items-center justify-between gap-1">
                          IVA {taxesIncluded ? '(incluido)' : '(+₡)'}
                          <label className="flex items-center gap-1 normal-case cursor-pointer">
                            <input
                              type="checkbox"
                              checked={taxesIncluded}
                              onChange={(e) => setTaxesIncluded(e.target.checked)}
                              className="accent-current"
                            />
                            incluido
                          </label>
                        </span>
                      </span>
                      <input
                        type="number"
                        step="50"
                        value={taxes}
                        onChange={(e) => setTaxes(parseFloat(e.target.value) || 0)}
                        className="bg-transparent font-bold text-sm w-full focus:outline-none"
                      />
                    </div>
                    <div className="liquid-glass-subtle rounded-lg p-2.5">
                      <span className="text-[10px] uppercase text-[var(--text-muted)] block">
                        Total Factura (₡)
                      </span>
                      <input
                        type="number"
                        step="50"
                        value={receiptGrandTotal}
                        onChange={(e) => setReceiptGrandTotal(parseFloat(e.target.value) || 0)}
                        className={`bg-transparent font-extrabold text-sm w-full focus:outline-none ${
                          hasMathDiscrepancy
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-avocado-600 dark:text-avocado-400'
                        }`}
                      />
                    </div>
                  </div>
                </div>

                {/* Action Buttons: pinned to the bottom of the screen while scrolling */}
                <div className="sticky bottom-0 z-10 -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 bg-[var(--glass-bg-elevated,var(--bg-primary))] backdrop-blur-xl border-t border-[var(--glass-border)]">
                  <button
                    type="button"
                    onClick={() => setStep('upload')}
                    className="liquid-glass liquid-glass-interactive px-4 py-2.5 rounded-xl text-xs font-semibold"
                  >
                    ← Escanear otra
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmAndSave}
                    className="liquid-lens-btn px-6 py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    {isEditing ? 'Guardar cambios' : 'Guardar compra'} ({formatCurrency(receiptGrandTotal, currency)})
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

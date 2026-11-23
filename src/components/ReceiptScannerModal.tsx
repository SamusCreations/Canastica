import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileText,
  FileWarning,
  PencilLine,
  Plus,
  RefreshCw,
  ScanLine,
  Sparkles,
  Store,
  Trash2,
  Upload,
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
import { Sheet } from './ui/Sheet';
import { Button, Field, FormSection, MoneyInput, Segmented, SelectInput, Stepper, Switch, TextInput } from './ui/Form';
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
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [expandNewest, setExpandNewest] = useState(false);

  // "Agregar producto" opens the new row ready to type
  useEffect(() => {
    if (!expandNewest || draftItems.length === 0) return;
    const last = draftItems[draftItems.length - 1];
    setExpandedIds((prev) => new Set(prev).add(last.id));
    setExpandNewest(false);
  }, [expandNewest, draftItems]);

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

  const closeScanner = () => {
    setStep('upload');
    onClose();
  };

  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addItemAndEdit = () => {
    handleAddManualDraftItem();
    setExpandNewest(true);
  };

  const setAssignee = (id: string, value: string) =>
    setDraftItems((prev) =>
      prev.map((d) =>
        d.id !== id
          ? d
          : value === 'shared'
            ? { ...d, isShared: true, assignedTo: undefined }
            : { ...d, isShared: false, assignedTo: value }
      )
    );

  const symbol = currency === 'USD' ? '$' : '₡';
  const sheetTitle = isEditing
    ? language === 'es'
      ? 'Editar compra'
      : 'Edit purchase'
    : step === 'confirm'
      ? language === 'es'
        ? 'Revisar y guardar'
        : 'Review and save'
      : language === 'es'
        ? 'Registrar compra'
        : 'Add purchase';

  const footer =
    step === 'confirm' ? (
      <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-2">
        {!isEditing && (
          <Button variant="ghost" onClick={() => setStep('upload')}>
            <RefreshCw className="w-4 h-4" /> Escanear otra
          </Button>
        )}
        <div className="sm:ml-auto flex items-center gap-3">
          <span className="hidden sm:block text-sm text-[var(--text-muted)]">
            {draftItems.length} {draftItems.length === 1 ? 'producto' : 'productos'}
          </span>
          <Button size="lg" block className="sm:w-auto" onClick={handleConfirmAndSave} disabled={draftItems.length === 0}>
            <CheckCircle2 className="w-5 h-5" />
            {isEditing ? 'Guardar cambios' : 'Guardar compra'} · {formatCurrency(receiptGrandTotal, currency)}
          </Button>
        </div>
      </div>
    ) : undefined;

  const receiptPreview = (
    <div className="rounded-2xl bg-[var(--glass-bg-subtle)] border border-[var(--glass-border)] p-2 flex justify-center">
      {receiptImageUrl && receiptFileKind(receiptImageUrl) !== 'image' ? (
        <a
          href={receiptImageUrl}
          target="_blank"
          rel="noreferrer"
          download={receiptFileKind(receiptImageUrl) === 'xml' ? 'factura.xml' : 'factura.pdf'}
          className="py-10 flex flex-col items-center gap-2 text-sm font-semibold text-avocado-700 dark:text-avocado-300"
        >
          <FileText className="w-10 h-10" />
          {receiptFileKind(receiptImageUrl) === 'xml' ? 'Factura electrónica (XML)' : 'Factura en PDF'}
        </a>
      ) : receiptImageUrl ? (
        <a href={receiptImageUrl} target="_blank" rel="noreferrer" title="Abrir la foto completa">
          <img src={receiptImageUrl} alt="Factura escaneada" className="max-w-full max-h-[60vh] object-contain rounded-xl" />
        </a>
      ) : (
        <p className="py-8 text-sm text-[var(--text-muted)]">Sin imagen de la factura</p>
      )}
    </div>
  );

  return (
    <Sheet onClose={closeScanner} title={sheetTitle} icon={<ScanLine className="w-5 h-5" />} size="xl" tall={step === 'confirm'} footer={footer}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf,.pdf,.xml,text/xml,application/xml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFileUpload(f);
          e.target.value = '';
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
          e.target.value = '';
        }}
      />

      {step === 'upload' && (
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
          className={`max-w-2xl mx-auto space-y-3 rounded-3xl transition ${isDragging ? 'ring-4 ring-avocado-400/40 bg-avocado-50/50 dark:bg-white/5' : ''}`}
        >
          <button
            onClick={() => cameraInputRef.current?.click()}
            disabled={!aiAvailable}
            className="w-full rounded-3xl bg-avocado-600 hover:bg-avocado-700 text-white p-6 sm:p-8 flex flex-col items-center gap-3 text-center transition disabled:opacity-50"
          >
            <span className="w-16 h-16 rounded-2xl bg-white/15 flex items-center justify-center">
              <Camera className="w-8 h-8" />
            </span>
            <span className="text-lg font-bold">Tomar foto de la factura</span>
            <span className="text-sm text-avocado-100 max-w-sm">
              La IA lee productos, descuentos y el total. Tú solo revisas antes de guardar.
            </span>
          </button>
          <div className="grid sm:grid-cols-2 gap-3">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="card p-4 flex items-center gap-3 text-left hover:border-avocado-400 transition min-h-[72px]"
            >
              <Upload className="w-6 h-6 text-avocado-600 dark:text-avocado-400 shrink-0" />
              <span>
                <span className="block font-semibold">Subir archivo</span>
                <span className="block text-xs text-[var(--text-muted)]">Foto, PDF o XML de factura electrónica</span>
              </span>
            </button>
            <button
              onClick={handleEnterManually}
              className="card p-4 flex items-center gap-3 text-left hover:border-avocado-400 transition min-h-[72px]"
            >
              <PencilLine className="w-6 h-6 text-avocado-600 dark:text-avocado-400 shrink-0" />
              <span>
                <span className="block font-semibold">Registrar a mano</span>
                <span className="block text-xs text-[var(--text-muted)]">Sin foto, producto por producto</span>
              </span>
            </button>
          </div>
          <p className="hidden sm:block text-center text-xs text-[var(--text-muted)] pt-1">También puedes arrastrar el archivo aquí.</p>
          {aiQuota && !aiQuota.exempt && (
            <p className={`text-center text-xs ${aiAvailable ? 'text-[var(--text-muted)]' : 'text-amber-700 dark:text-amber-300 font-semibold'}`}>
              {describeAiQuota(aiQuota)}
              {!aiAvailable && ' Puedes registrar la factura a mano.'}
            </p>
          )}
        </div>
      )}

      {step === 'scanning' && (
        <div className="py-10 flex flex-col items-center gap-6 max-w-xl mx-auto">
          <span className="w-14 h-14 rounded-2xl bg-avocado-600 text-white flex items-center justify-center">
            <Sparkles className="w-7 h-7 animate-spin" />
          </span>
          <div className="text-center space-y-1" aria-live="polite">
            <h3 className="text-lg font-bold">{scanStageText}</h3>
            <p className="text-sm text-[var(--text-muted)]">Esto puede tardar unos segundos.</p>
          </div>
          <div className="w-full space-y-3">
            <div className="h-12 rounded-xl liquid-skeleton" />
            <div className="h-16 rounded-xl liquid-skeleton" />
            <div className="h-16 rounded-xl liquid-skeleton" />
          </div>
        </div>
      )}

      {step === 'ai_unavailable' && (
        <div className="max-w-md mx-auto text-center space-y-4 py-4">
          <span className="w-14 h-14 rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto">
            <Clock className="w-7 h-7" />
          </span>
          <h3 className="text-lg font-bold">
            {aiUnavailableReason === 'slow' ? 'La IA está tardando mucho' : 'La IA no está disponible ahora'}
          </h3>
          <p className="text-sm text-[var(--text-secondary)]">
            {aiUnavailableReason === 'slow'
              ? 'Puedes dejar la factura en cola y te avisamos cuando esté lista para revisar, o registrarla a mano.'
              : blurryAdvice || 'Puedes dejar la factura en cola o registrarla a mano.'}
          </p>
          <div className="flex flex-col gap-2">
            <Button size="lg" onClick={handleQueueReceipt}>
              <Clock className="w-4 h-4" /> Dejar en cola
            </Button>
            <Button size="lg" variant="secondary" onClick={handleManualInsteadOfWaiting}>
              <PencilLine className="w-4 h-4" /> Registrar a mano
            </Button>
          </div>
          {aiUnavailableReason === 'slow' && (
            <p className="text-xs text-[var(--text-muted)]">Si la IA responde mientras decides, se abre sola.</p>
          )}
        </div>
      )}

      {step === 'queued' && (
        <div className="max-w-md mx-auto text-center space-y-4 py-4">
          <CheckCircle2 className="w-14 h-14 mx-auto text-avocado-600" />
          <h3 className="text-lg font-bold">Factura en cola</h3>
          <p className="text-sm text-[var(--text-secondary)]">
            La leeremos cuando la IA esté disponible y te avisaremos para que la revises antes de guardarla.
          </p>
          <div className="flex flex-col gap-2">
            <Button size="lg" onClick={closeScanner}>
              Listo
            </Button>
            <Button size="lg" variant="secondary" onClick={() => setStep('upload')}>
              Escanear otra
            </Button>
          </div>
        </div>
      )}

      {step === 'blurry_error' && (
        <div className="max-w-md mx-auto space-y-4 py-2">
          <div className="text-center space-y-2">
            <span className="w-14 h-14 rounded-2xl bg-coral-500/15 text-coral-500 flex items-center justify-center mx-auto">
              <FileWarning className="w-7 h-7" />
            </span>
            <h3 className="text-lg font-bold">No pudimos leer bien la factura</h3>
            <p className="text-sm text-[var(--text-secondary)]">{blurryAdvice}</p>
          </div>
          <ul className="rounded-2xl bg-[var(--glass-bg-subtle)] p-4 text-sm space-y-1.5 text-[var(--text-secondary)] list-disc list-inside">
            <li>Alisa el papel sobre una mesa.</li>
            <li>Usa buena luz, sin sombras sobre los precios.</li>
            <li>Que se vean los nombres y los montos completos.</li>
          </ul>
          <div className="flex flex-col gap-2">
            <Button size="lg" onClick={() => setStep('upload')}>
              <RefreshCw className="w-4 h-4" /> Intentar con otra foto
            </Button>
            {failedImageUrl && (
              <Button size="lg" variant="secondary" onClick={handleEnterManually}>
                <PencilLine className="w-4 h-4" /> Registrar a mano con esta foto
              </Button>
            )}
            {getSupabaseClient() && (
              <Button
                variant="ghost"
                onClick={() => openReportProblem({ prefill: `Error al escanear una factura: "${blurryAdvice}"\n\n` })}
              >
                <FileWarning className="w-4 h-4" /> Reportar este problema
              </Button>
            )}
          </div>
        </div>
      )}

      {step === 'confirm' && (
        <div className="lg:grid lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:gap-8 lg:items-start">
          {/* Receipt photo: sticky column on desktop, collapsible on phones */}
          <aside className="hidden lg:block lg:sticky lg:top-0 space-y-3">{receiptPreview}</aside>

          <div className="space-y-6 min-w-0">
            {/* Sum check */}
            {hasMathDiscrepancy ? (
              <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
                <p className="text-sm flex gap-2.5">
                  <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
                  <span>
                    <strong className="block">
                      La suma no cuadra por {formatCurrency(Math.abs(totalDifference), currency)}
                    </strong>
                    <span className="text-[var(--text-secondary)]">
                      Productos {formatCurrency(computedGrandTotal, currency)} vs. total de la factura{' '}
                      {formatCurrency(receiptGrandTotal, currency)}. Revisa los productos o ajusta el total.
                    </span>
                  </span>
                </p>
                <Button variant="secondary" size="sm" onClick={() => setReceiptGrandTotal(computedGrandTotal)}>
                  Usar {formatCurrency(computedGrandTotal, currency)} como total
                </Button>
              </div>
            ) : draftItems.length > 0 ? (
              <p className="rounded-2xl bg-avocado-50 dark:bg-avocado-500/10 px-4 py-3 text-sm flex items-center gap-2.5 text-avocado-800 dark:text-avocado-200">
                <CheckCircle2 className="w-5 h-5 shrink-0" />
                La suma de los productos coincide con el total
                {itemPromos > 0 && <> (incluye {formatCurrency(itemPromos, currency)} en promociones)</>}.
              </p>
            ) : null}

            {(scanWarnings.length > 0 || reviewCount > 0 || wasRepaired) && (
              <div className="space-y-1.5 text-sm">
                {wasRepaired && (
                  <p className="flex items-start gap-2 text-[var(--text-secondary)]">
                    <RefreshCw className="w-4 h-4 shrink-0 mt-0.5 text-avocado-600" />
                    La primera lectura no cuadraba; se hizo una segunda lectura automática.
                  </p>
                )}
                {scanWarnings
                  .filter((w) => !w.startsWith('La suma'))
                  .map((w) => (
                    <p key={w} className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {w}
                    </p>
                  ))}
                {reviewCount > 0 && (
                  <p className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    {reviewCount === 1 ? '1 producto para revisar (marcado abajo).' : `${reviewCount} productos para revisar (marcados abajo).`}
                  </p>
                )}
              </div>
            )}

            {receiptImageUrl && (
              <details className="lg:hidden group rounded-2xl border border-[var(--glass-border)]">
                <summary className="list-none cursor-pointer min-h-12 px-4 flex items-center justify-between text-sm font-semibold">
                  <span className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-avocado-600" /> Ver la factura original
                  </span>
                  <ChevronDown className="w-4 h-4 text-[var(--text-muted)] transition group-open:rotate-180" />
                </summary>
                <div className="px-2 pb-2">{receiptPreview}</div>
              </details>
            )}

            {/* Purchase details */}
            <FormSection title="Datos de la compra">
              <div className="grid sm:grid-cols-2 gap-4">
                <Field
                  label="Comercio"
                  className="sm:col-span-2"
                  action={
                    <button
                      type="button"
                      onClick={() => setShowNewStoreForm((s) => !s)}
                      className="text-sm font-semibold text-avocado-700 dark:text-avocado-300 min-h-8 flex items-center gap-1"
                    >
                      {showNewStoreForm ? 'Cancelar' : <><Plus className="w-4 h-4" /> Nuevo</>}
                    </button>
                  }
                >
                  {(id) => (
                    <SelectInput id={id} value={supermarket} onChange={(e) => setSupermarket(e.target.value)}>
                      {supermarkets.map((st) => (
                        <option key={st.id} value={st.name}>
                          {st.name}
                        </option>
                      ))}
                      {!supermarkets.some((s) => s.name === supermarket) && <option value={supermarket}>{supermarket}</option>}
                    </SelectInput>
                  )}
                </Field>

                {showNewStoreForm && (
                  <div className="sm:col-span-2 rounded-2xl bg-[var(--glass-bg-subtle)] border border-[var(--glass-border)] p-4 space-y-3 animate-spring-in">
                    <p className="text-sm font-bold flex items-center gap-2">
                      <Store className="w-4 h-4 text-avocado-600" /> Nuevo comercio
                    </p>
                    <Field label="Nombre">
                      {(id) => (
                        <TextInput
                          id={id}
                          value={newStoreName}
                          onChange={(e) => setNewStoreName(e.target.value)}
                          placeholder="Ej. Pulpería La Amistad"
                          autoComplete="off"
                          enterKeyHint="next"
                        />
                      )}
                    </Field>
                    <div className="grid sm:grid-cols-2 gap-3">
                      <Field label="Tipo">
                        {(id) => (
                          <SelectInput id={id} value={newStoreType} onChange={(e) => setNewStoreType(e.target.value as SupermarketType)}>
                            <option value="Abastecedor / Pulpería">Abastecedor / Pulpería</option>
                            <option value="Feria del Agricultor">Feria del Agricultor</option>
                            <option value="Carnicería / Especialidad">Carnicería / Especialidad</option>
                            <option value="Cadena Nacional">Cadena nacional</option>
                            <option value="Club Mayorista">Club mayorista</option>
                            <option value="Otro">Otro</option>
                          </SelectInput>
                        )}
                      </Field>
                      <Field label="Zona (opcional)">
                        {(id) => (
                          <TextInput id={id} value={newStoreLocation} onChange={(e) => setNewStoreLocation(e.target.value)} placeholder="Ej. San Pedro" />
                        )}
                      </Field>
                    </div>
                    <Button variant="soft" onClick={handleCreateCustomStoreInline} disabled={!newStoreName.trim()}>
                      Agregar y usar este comercio
                    </Button>
                  </div>
                )}

                <Field
                  label="Fecha"
                  error={dateSource === 'none' ? 'La factura no trae fecha: confírmala.' : undefined}
                  hint={dateSource === 'clave' ? 'Tomada de la clave de la factura electrónica.' : undefined}
                >
                  {(id) => (
                    <TextInput
                      id={id}
                      type="date"
                      value={purchaseDate}
                      max={getTodayIso()}
                      onChange={(e) => {
                        setPurchaseDate(e.target.value);
                        setDateSource('printed');
                      }}
                      className={dateSource === 'none' ? 'border-amber-500 ring-4 ring-amber-500/15' : ''}
                    />
                  )}
                </Field>
                <Field label="Pagó">
                  {(id) =>
                    members.length <= 3 ? (
                      <Segmented
                        aria-label="Quién pagó"
                        value={paidByMemberId}
                        onChange={setPaidByMemberId}
                        options={members.map((m) => ({ value: m.id, label: m.name.split(' ')[0] }))}
                      />
                    ) : (
                      <SelectInput id={id} value={paidByMemberId} onChange={(e) => setPaidByMemberId(e.target.value)}>
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </SelectInput>
                    )
                  }
                </Field>
              </div>
            </FormSection>

            {/* Items */}
            <FormSection
              title={`Productos (${draftItems.length})`}
              description="Toca un producto para corregir nombre, cantidad o precio."
            >
              {draftItems.length === 0 && (
                <p className="rounded-2xl border-2 border-dashed border-[var(--glass-border-strong)] p-5 text-center text-sm text-[var(--text-muted)]">
                  Aún no hay productos. Agrega el primero.
                </p>
              )}
              <ul className="space-y-2">
                {draftItems.map((item) => {
                  const open = expandedIds.has(item.id) || Boolean(item.needsReview);
                  const assigneeName = item.isShared
                    ? null
                    : members.find((m) => m.id === (item.assignedTo ?? paidByMemberId))?.name.split(' ')[0];
                  return (
                    <li
                      key={item.id}
                      className={`rounded-2xl border bg-[var(--bg-primary)] ${
                        item.needsReview ? 'border-amber-500/60' : open ? 'border-avocado-300 dark:border-avocado-700' : 'border-[var(--glass-border)]'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleExpanded(item.id)}
                        aria-expanded={open}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left min-h-14"
                      >
                        <span className="flex-1 min-w-0">
                          <span className="block text-[15px] font-semibold truncate">
                            {item.normalizedName || <span className="text-[var(--text-muted)] font-normal">Producto sin nombre</span>}
                          </span>
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--text-muted)]">
                            <span>
                              {item.quantity} {item.unit}
                            </span>
                            {item.discount > 0 && <span className="text-avocado-700 dark:text-avocado-300">promo −{formatCurrency(item.discount, currency)}</span>}
                            {assigneeName && <span>· de {assigneeName}</span>}
                            {item.learnedFromHistory && <span>· reconocido</span>}
                            {item.needsReview && (
                              <span className="text-amber-700 dark:text-amber-300 font-semibold flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" /> Revisar
                              </span>
                            )}
                          </span>
                        </span>
                        <span className="text-[15px] font-semibold tabular-nums">{formatCurrency(item.totalPrice, currency)}</span>
                        <ChevronDown className={`w-4 h-4 text-[var(--text-muted)] transition ${open ? 'rotate-180' : ''}`} />
                      </button>

                      {open && (
                        <div className="px-4 pb-4 pt-1 space-y-4 border-t border-[var(--glass-border)]">
                          {item.rawReceiptName && item.rawReceiptName !== 'MANUAL' && (
                            <p className="pt-3 text-xs text-[var(--text-muted)]">
                              En la factura: <span className="font-mono">{item.rawReceiptName}</span>
                              {item.barcode && <span className="opacity-70"> · {item.barcode}</span>}
                            </p>
                          )}
                          {(item.reviewReasons?.length ?? 0) > 0 && (
                            <p className="text-sm text-amber-700 dark:text-amber-300">{item.reviewReasons?.join(' ')}</p>
                          )}
                          <div className="grid sm:grid-cols-2 gap-4 pt-1">
                            <Field label="Producto" className="sm:col-span-2">
                              {(id) => (
                                <TextInput
                                  id={id}
                                  value={item.normalizedName}
                                  onChange={(e) => handleUpdateDraftItem(item.id, 'normalizedName', e.target.value)}
                                  placeholder="Ej. Leche Dos Pinos 1L"
                                  autoComplete="off"
                                  enterKeyHint="next"
                                />
                              )}
                            </Field>
                            <Field label="Cantidad">
                              {() => (
                                <Stepper
                                  label="cantidad"
                                  value={item.quantity}
                                  min={0}
                                  step={item.pricingMode === 'weight' ? 0.1 : 1}
                                  onChange={(v) => handleUpdateDraftItem(item.id, 'quantity', v)}
                                />
                              )}
                            </Field>
                            <Field label="Unidad">
                              {(id) => (
                                <TextInput
                                  id={id}
                                  value={item.unit}
                                  onChange={(e) => handleUpdateDraftItem(item.id, 'unit', e.target.value)}
                                  placeholder="unid, kg, L…"
                                  list="canastica-units"
                                />
                              )}
                            </Field>
                            <Field label="Precio por unidad">
                              {(id) => (
                                <MoneyInput
                                  id={id}
                                  symbol={symbol}
                                  value={item.unitPrice}
                                  onValueChange={(v) => handleUpdateDraftItem(item.id, 'unitPrice', v)}
                                />
                              )}
                            </Field>
                            <Field label="Total pagado" hint={item.discount > 0 ? `Ya con la promoción. Antes ${formatCurrency(item.grossPrice, currency)}.` : undefined}>
                              {(id) => (
                                <MoneyInput
                                  id={id}
                                  symbol={symbol}
                                  value={item.totalPrice}
                                  onValueChange={(v) => handleUpdateDraftItem(item.id, 'totalPrice', v)}
                                  className="font-semibold"
                                />
                              )}
                            </Field>
                            {item.discount > 0 && (
                              <Field label={item.discountLabel || 'Promoción'}>
                                {(id) => (
                                  <MoneyInput
                                    id={id}
                                    symbol={`−${symbol}`}
                                    value={item.discount}
                                    onValueChange={(v) => handleUpdateDraftItem(item.id, 'discount', v)}
                                    className="pl-10"
                                  />
                                )}
                              </Field>
                            )}
                            <Field label="Categoría">
                              {(id) => (
                                <SelectInput
                                  id={id}
                                  value={item.category}
                                  onChange={(e) => handleUpdateDraftItem(item.id, 'category', e.target.value as GroceryCategory)}
                                >
                                  {categories.map((cat) => (
                                    <option key={cat} value={cat}>
                                      {translateCategory(cat, language)}
                                    </option>
                                  ))}
                                </SelectInput>
                              )}
                            </Field>
                            <Field label="¿De quién es?">
                              {(id) => (
                                <SelectInput
                                  id={id}
                                  value={item.isShared ? 'shared' : item.assignedTo ?? paidByMemberId}
                                  onChange={(e) => setAssignee(item.id, e.target.value)}
                                >
                                  <option value="shared">De todo el hogar</option>
                                  {members.map((m) => (
                                    <option key={m.id} value={m.id}>
                                      Solo de {m.name.split(' ')[0]}
                                    </option>
                                  ))}
                                </SelectInput>
                              )}
                            </Field>
                          </div>
                          <div className="flex items-center justify-between gap-2 pt-1">
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => setDraftItems((prev) => prev.filter((i) => i.id !== item.id))}
                            >
                              <Trash2 className="w-4 h-4" /> Quitar
                            </Button>
                            <Button variant="soft" size="sm" onClick={() => toggleExpanded(item.id)}>
                              <Check className="w-4 h-4" /> Listo
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <Button variant="secondary" block onClick={addItemAndEdit}>
                <Plus className="w-4 h-4" /> Agregar producto
              </Button>
              <datalist id="canastica-units">
                <option value="unid" />
                <option value="kg" />
                <option value="g" />
                <option value="L" />
                <option value="ml" />
                <option value="paquete" />
                <option value="bolsa" />
              </datalist>
            </FormSection>

            {/* Totals */}
            <FormSection title="Totales">
              <div className="rounded-2xl border border-[var(--glass-border)] divide-y divide-[var(--glass-border)]">
                <div className="flex items-center justify-between px-4 min-h-12 text-sm">
                  <span className="text-[var(--text-secondary)]">Productos (con promociones)</span>
                  <span className="font-semibold tabular-nums">{formatCurrency(itemsSubtotal, currency)}</span>
                </div>
                <div className="px-4 py-3 grid grid-cols-[1fr_minmax(0,9.5rem)] items-center gap-3">
                  <label htmlFor="scanner-discounts" className="text-sm text-[var(--text-secondary)]">
                    Otros descuentos
                  </label>
                  <MoneyInput id="scanner-discounts" symbol={`−${symbol}`} value={discounts} onValueChange={setDiscounts} className="pl-10 text-right" />
                </div>
                <div className="px-4 py-3 grid grid-cols-[1fr_minmax(0,9.5rem)] items-center gap-3">
                  <span className="text-sm text-[var(--text-secondary)] flex items-center gap-3">
                    <Switch checked={taxesIncluded} onChange={setTaxesIncluded} label="IVA incluido en los precios" />
                    <span>{taxesIncluded ? 'IVA incluido' : 'IVA aparte'}</span>
                  </span>
                  <MoneyInput id="scanner-taxes" symbol={symbol} value={taxes} onValueChange={setTaxes} className="text-right" aria-label="Monto de IVA" />
                </div>
                <div className="px-4 py-3 grid grid-cols-[1fr_minmax(0,9.5rem)] items-center gap-3">
                  <label htmlFor="scanner-total" className="text-[15px] font-bold">
                    Total de la factura
                  </label>
                  <MoneyInput
                    id="scanner-total"
                    symbol={symbol}
                    value={receiptGrandTotal}
                    onValueChange={setReceiptGrandTotal}
                    className={`text-right font-bold ${hasMathDiscrepancy ? 'border-amber-500' : ''}`}
                  />
                </div>
              </div>
            </FormSection>
          </div>
        </div>
      )}
    </Sheet>
  );
};

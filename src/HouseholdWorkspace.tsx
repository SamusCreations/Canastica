import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Bot,
  Camera,
  CheckCircle2,
  Globe,
  LayoutDashboard,
  Loader2,
  Moon,
  Refrigerator,
  RefreshCw,
  ShoppingCart,
  Sun,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import { AccountSheet } from './components/AccountSheet';
import { AIAssistantDrawer } from './components/AIAssistantDrawer';
import { AnalyticsAndPricesView } from './components/AnalyticsAndPricesView';
import { Avatar } from './components/Avatar';
import { DashboardView } from './components/DashboardView';
import { HouseholdAndSplitsView } from './components/HouseholdAndSplitsView';
import { PantryView } from './components/PantryView';
import { ReceiptDetailModal } from './components/ReceiptDetailModal';
import { ReceiptScannerModal } from './components/ReceiptScannerModal';
import { RestockPredictionView } from './components/RestockPredictionView';
import { ShoppingListView } from './components/ShoppingListView';
import {
  getIsoDaysFromNow,
  INITIAL_HOUSEHOLD,
  INITIAL_NOTIFICATIONS,
  INITIAL_PANTRY,
  INITIAL_PURCHASES,
  INITIAL_SETTLEMENTS,
  INITIAL_SHOPPING_LIST,
} from './data/seedHousehold';
import { calculateRestockPredictions, normalizeReceiptProduct } from './lib/restockEngine';
import {
  matchPurchasedItemsToShoppingList,
  parseShoppingInputLocally,
  parseShoppingInputWithAI,
  scanReceiptImageWithAI,
  type ScannedReceiptResult,
} from './services/geminiAndSupabaseService';
import {
  getAiQueue,
  loadAiQueue,
  notifyAiQueue,
  removeAiQueueEntry,
  subscribeAiQueue,
  updateAiQueueEntry,
} from './lib/aiQueue';
import {
  describeSupabaseError,
  HouseholdMembership,
  insertNotification,
  deletePantryItems,
  insertPantryItems,
  insertPurchase,
  deletePurchase,
  updatePurchase,
  insertSettlement,
  fetchHouseholdActivity,
  insertShoppingItems,
  deleteShoppingItems,
  loadHouseholdSnapshot,
  markNotificationsRead,
  newId,
  saveFeedbackMultiplier,
  setPurchaseItemShared,
  syncRestockPredictions,
  updateHouseholdSettings,
  updateMemberRole,
  updatePantryItems,
  updateShoppingItems,
  updateSupermarkets,
} from './services/householdRepository';
import {
  AutoCrossOffSummary,
  BaseUnit,
  CurrencyCode,
  ExpenseSettlement,
  GroceryCategory,
  Household,
  HouseholdNotification,
  LanguageCode,
  PantryItem,
  Purchase,
  ShoppingListItem,
  SupermarketStore,
  UserRole,
} from './types/grocery';
import {
  DEMO_REFERENCE_DATE,
  getCurrentMonthPrefix,
  getTodayIso,
  monthName,
  setReferenceDate,
} from './utils/dates';
import { devLog } from './lib/devConsole';
import { setReportScreenContext } from './lib/appContext';
import { formatCurrency } from './utils/formatters';
import { BrandMark } from './components/BrandLogo';

// A list-originated pantry entry counts as the same product for this long after it was checked off
const LIST_TO_RECEIPT_WINDOW_DAYS = 30;

/** Pantry entry for a shopping list item the user checked off; shares the item's id. */
function pantryEntryFromListItem(item: ShoppingListItem, memberId: string): PantryItem {
  const norm = normalizeReceiptProduct(item.name);
  const unit = item.unit.trim().toLowerCase();
  let baseUnit: BaseUnit = norm.baseUnit;
  let baseQuantity = item.quantity;
  if (/^(l|lt|litros?)$/.test(unit)) [baseUnit, baseQuantity] = ['ml', item.quantity * 1000];
  else if (unit === 'ml') baseUnit = 'ml';
  else if (/^(kg|kilos?)$/.test(unit)) [baseUnit, baseQuantity] = ['g', item.quantity * 1000];
  else if (/^(g|gramos?)$/.test(unit)) baseUnit = 'g';
  else baseUnit = 'units';
  const today = getTodayIso();
  return {
    id: item.id,
    name: item.name,
    canonicalName: item.canonicalName || norm.canonicalName,
    category: item.category,
    storageLocation: norm.storageLocation,
    quantityLabel: `${item.quantity} ${item.unit}`,
    baseQuantity,
    baseUnit,
    remainingPercentage: 100,
    purchasedDate: today,
    estimatedExpiryDate: getIsoDaysFromNow(norm.shelfLifeDays, today),
    status: 'available',
    addedBy: memberId,
    fromShoppingList: true,
  };
}

/** The list-originated pantry entry a receipt product should replace, if any. */
function findListPantryEntry(
  pantry: PantryItem[],
  receiptEntry: PantryItem,
  alreadyReplaced: Set<string>
): PantryItem | undefined {
  const names = new Set(
    [receiptEntry.canonicalName, receiptEntry.name].map((n) => n.trim().toLowerCase()).filter(Boolean)
  );
  const oldest = getIsoDaysFromNow(-LIST_TO_RECEIPT_WINDOW_DAYS, receiptEntry.purchasedDate);
  return pantry.find(
    (p) =>
      p.fromShoppingList &&
      !alreadyReplaced.has(p.id) &&
      p.purchasedDate >= oldest &&
      (names.has(p.canonicalName.trim().toLowerCase()) || names.has(p.name.trim().toLowerCase()))
  );
}

const DEMO_STATE_STORAGE_KEY = 'glasscart_household_state_crc_v2';
const PREFS_STORAGE_KEY = 'glasscart_view_prefs_v1';

type TabId = 'dashboard' | 'shopping-list' | 'restock-ai' | 'pantry' | 'analytics' | 'household';

interface PersistedHouseholdState {
  household: Household;
  currentMemberId: string;
  purchases: Purchase[];
  shoppingList: ShoppingListItem[];
  pantry: PantryItem[];
  settlements: ExpenseSettlement[];
  notifications: HouseholdNotification[];
  feedbackMultipliers: Record<string, number>;
}

interface ViewPrefs {
  currency?: CurrencyCode;
  language?: LanguageCode;
}

function loadDemoState(): PersistedHouseholdState {
  try {
    const raw = localStorage.getItem(DEMO_STATE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        parsed.household &&
        Array.isArray(parsed.purchases) &&
        Array.isArray(parsed.household.supermarkets)
      ) {
        return parsed;
      }
    }
  } catch {
    // ignore storage read error
  }
  return {
    household: INITIAL_HOUSEHOLD,
    currentMemberId: 'mem-alex',
    purchases: INITIAL_PURCHASES,
    shoppingList: INITIAL_SHOPPING_LIST,
    pantry: INITIAL_PANTRY,
    settlements: INITIAL_SETTLEMENTS,
    notifications: INITIAL_NOTIFICATIONS,
    feedbackMultipliers: {},
  };
}

const EMPTY_HOUSEHOLD: Household = {
  ...INITIAL_HOUSEHOLD,
  id: '',
  name: '',
  inviteCode: '',
  members: [],
  supermarkets: [],
};

function emptyCloudState(userId: string): PersistedHouseholdState {
  return {
    household: EMPTY_HOUSEHOLD,
    currentMemberId: userId,
    purchases: [],
    shoppingList: [],
    pantry: [],
    settlements: [],
    notifications: [],
    feedbackMultipliers: {},
  };
}

function loadPrefs(): ViewPrefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

interface HouseholdWorkspaceProps {
  mode: 'demo' | 'cloud';
  sb: SupabaseClient | null;
  userId?: string;
  userEmail?: string;
  householdId?: string;
  memberships: HouseholdMembership[];
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onSwitchHousehold: (householdId: string) => void;
  onJoinHousehold: (inviteCode: string) => Promise<string | null>;
  onSignOut: () => void;
  onExitDemo: () => void;
}

export function HouseholdWorkspace({
  mode,
  sb,
  userId = '',
  userEmail,
  householdId = '',
  memberships,
  theme,
  onToggleTheme,
  onSwitchHousehold,
  onJoinHousehold,
  onSignOut,
  onExitDemo,
}: HouseholdWorkspaceProps) {
  const isCloud = mode === 'cloud' && Boolean(sb);
  // The demo dataset is frozen around its own "today"; real households use the device date
  setReferenceDate(isCloud ? null : DEMO_REFERENCE_DATE);

  const initial = useMemo(
    () => (isCloud ? emptyCloudState(userId) : loadDemoState()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const [activeTab, setActiveTab] = useState<TabId>('dashboard');

  // Core Household State
  const [baseHousehold, setHousehold] = useState<Household>(initial.household);
  const [demoMemberId, setCurrentMemberId] = useState<string>(initial.currentMemberId);
  const [purchases, setPurchases] = useState<Purchase[]>(initial.purchases);
  const [shoppingList, setShoppingList] = useState<ShoppingListItem[]>(initial.shoppingList);
  const [pantry, setPantry] = useState<PantryItem[]>(initial.pantry);
  const [settlements, setSettlements] = useState<ExpenseSettlement[]>(initial.settlements);
  const [notifications, setNotifications] = useState<HouseholdNotification[]>(
    initial.notifications
  );
  const [feedbackMultipliers, setFeedbackMultipliers] = useState<Record<string, number>>(
    initial.feedbackMultipliers
  );

  // Per-device display preferences (currency / language) so members don't need admin rights
  const [prefs, setPrefs] = useState<ViewPrefs>(loadPrefs);
  const household = useMemo<Household>(
    () => ({
      ...baseHousehold,
      currency: prefs.currency ?? baseHousehold.currency,
      language: prefs.language ?? baseHousehold.language,
    }),
    [baseHousehold, prefs]
  );
  const updatePrefs = (patch: ViewPrefs) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const currentMemberId = isCloud ? userId : demoMemberId;

  // Cloud loading / sync state
  const [isLoading, setIsLoading] = useState(isCloud);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const pendingWritesRef = useRef(0);
  const reloadRequestedRef = useRef(false);

  // Modals & Drawers
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [inspectedPurchase, setInspectedPurchase] = useState<Purchase | null>(null);
  const [editingPurchase, setEditingPurchase] = useState<Purchase | null>(null);
  const [queuedReview, setQueuedReview] = useState<{ id: string; dataUrl: string; result: ScannedReceiptResult } | null>(null);
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  const [assistantInitialPrompt, setAssistantInitialPrompt] = useState<string | null>(null);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);

  // Toast feedback
  const [toast, setToast] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const showToast = useCallback((text: string, kind: 'error' | 'success' = 'error') => {
    setToast({ kind, text });
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  // Auto-Cross-Off Undo State
  const [autoCrossOffSummary, setAutoCrossOffSummary] = useState<AutoCrossOffSummary | null>(
    null
  );
  const [lastCrossedOffIds, setLastCrossedOffIds] = useState<string[]>([]);

  // Network status
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const broadcastRef = useRef<BroadcastChannel | null>(null);

  // ------------------------------------------------------------------------
  // Cloud: load snapshot, realtime subscription & write-through persistence
  // ------------------------------------------------------------------------

  const reload = useCallback(async () => {
    if (!isCloud || !sb || !householdId) return;
    if (pendingWritesRef.current > 0) {
      // Wait until our own writes land so a refresh can't show stale rows
      reloadRequestedRef.current = true;
      return;
    }
    setIsSyncing(true);
    const started = performance.now();
    try {
      const snap = await loadHouseholdSnapshot(sb, householdId);
      devLog('success', 'Supabase', 'Datos del hogar cargados', {
        durationMs: Math.round(performance.now() - started),
        detail: {
          householdId,
          purchases: snap.purchases.length,
          shoppingList: snap.shoppingList.length,
          pantry: snap.pantry.length,
          latestPurchases: snap.purchases
            .slice(0, 5)
            .map((p) => ({ date: p.purchaseDate, store: p.supermarket, total: p.totalAmount })),
        },
      });
      setHousehold(snap.household);
      setPurchases(snap.purchases);
      setShoppingList(snap.shoppingList);
      setPantry(snap.pantry);
      setSettlements(snap.settlements);
      setNotifications(snap.notifications);
      setFeedbackMultipliers(snap.feedbackMultipliers);
      setLoadError(null);
    } catch (err) {
      setLoadError(describeSupabaseError(err));
    } finally {
      setIsLoading(false);
      setIsSyncing(false);
    }
  }, [isCloud, sb, householdId]);

  useEffect(() => {
    // Initial fetch of the household snapshot from Supabase
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const persist = useCallback(
    (op: (client: SupabaseClient) => Promise<void>) => {
      if (!isCloud || !sb) return;
      pendingWritesRef.current += 1;
      const started = performance.now();
      op(sb)
        .then(() =>
          devLog('success', 'Supabase', 'Cambio guardado', {
            durationMs: Math.round(performance.now() - started),
          })
        )
        .catch((err) => {
          showToast(describeSupabaseError(err));
          // Re-sync with the server so the UI never shows a change that wasn't saved
          reloadRequestedRef.current = true;
        })
        .finally(() => {
          pendingWritesRef.current -= 1;
          if (pendingWritesRef.current === 0 && reloadRequestedRef.current) {
            reloadRequestedRef.current = false;
            void reload();
          }
        });
    },
    [isCloud, sb, reload, showToast]
  );

  useEffect(() => {
    if (!isCloud || !sb || !householdId) return;
    let timer: number | undefined;
    const scheduleReload = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void reload(), 450);
    };

    const tables = [
      'purchases',
      'purchase_items',
      'shopping_list_items',
      'pantry_items',
      'household_notifications',
      'household_members',
      'categories',
      'expense_settlements',
      'canonical_products',
    ];
    const channel = sb.channel(`glasscart-household-${householdId}`);
    tables.forEach((table) =>
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `household_id=eq.${householdId}` },
        scheduleReload
      )
    );
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'households', filter: `id=eq.${householdId}` },
      scheduleReload
    );
    // Supabase Realtime can't filter DELETE events, so listen to them unfiltered
    ['shopping_list_items', 'pantry_items', 'purchases'].forEach((table) =>
      channel.on('postgres_changes', { event: 'DELETE', schema: 'public', table }, scheduleReload)
    );
    channel.subscribe((status, err) => {
      setRealtimeConnected(status === 'SUBSCRIBED');
      devLog(status === 'SUBSCRIBED' ? 'success' : 'warn', 'Tiempo real', status, {
        detail: err ? String(err) : undefined,
      });
    });

    // Catch up after the phone wakes the tab back up
    const onVisible = () => {
      if (document.visibilityState === 'visible') scheduleReload();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      void sb.removeChannel(channel);
    };
  }, [isCloud, sb, householdId, reload]);

  // ------------------------------------------------------------------------
  // Demo: local offline cache & cross-tab sync
  // ------------------------------------------------------------------------

  useEffect(() => {
    if (isCloud) return;
    const stateToSave: PersistedHouseholdState = {
      household: baseHousehold,
      currentMemberId: demoMemberId,
      purchases,
      shoppingList,
      pantry,
      settlements,
      notifications,
      feedbackMultipliers,
    };
    try {
      localStorage.setItem(DEMO_STATE_STORAGE_KEY, JSON.stringify(stateToSave));
    } catch {
      // ignore quota error
    }
  }, [
    isCloud,
    baseHousehold,
    demoMemberId,
    purchases,
    shoppingList,
    pantry,
    settlements,
    notifications,
    feedbackMultipliers,
  ]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    if (!isCloud && 'BroadcastChannel' in window) {
      const bc = new BroadcastChannel('glasscart_realtime_sync');
      bc.onmessage = (ev) => {
        if (ev.data?.type === 'STATE_SYNC' && ev.data?.payload) {
          const p: PersistedHouseholdState = ev.data.payload;
          setHousehold(p.household);
          setPurchases(p.purchases);
          setShoppingList(p.shoppingList);
          setPantry(p.pantry);
          setSettlements(p.settlements);
          setNotifications(p.notifications);
          setFeedbackMultipliers(p.feedbackMultipliers);
        }
      };
      broadcastRef.current = bc;
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      broadcastRef.current?.close();
    };
  }, [isCloud]);

  // ------------------------------------------------------------------------
  // Derived data
  // ------------------------------------------------------------------------

  const { predictions, learningProducts } = useMemo(() => {
    return calculateRestockPredictions(purchases, {
      lookbackMonths: household.restockLookbackMonths,
      alertThresholdDays: household.restockAlertDays,
      minPurchases: household.minPurchasesForPrediction,
      feedbackMultipliers,
      language: household.language,
      referenceDate: getTodayIso(),
    });
  }, [
    purchases,
    household.restockLookbackMonths,
    household.restockAlertDays,
    household.minPurchasesForPrediction,
    household.language,
    feedbackMultipliers,
  ]);

  // Mirror predictions to Supabase so the nightly pg_cron job can auto-add items
  const lastSyncedPredictionsRef = useRef('');
  useEffect(() => {
    if (!isCloud || isLoading || predictions.length === 0) return;
    const signature = predictions
      .map(
        (p) =>
          `${p.canonicalName}|${p.lastPurchaseDate}|${p.expectedDurationDays.toFixed(1)}|${p.estimatedDaysRemaining.toFixed(1)}`
      )
      .join(';');
    if (signature === lastSyncedPredictionsRef.current) return;
    lastSyncedPredictionsRef.current = signature;
    persist((client) => syncRestockPredictions(client, householdId, predictions));
  }, [isCloud, isLoading, predictions, persist, householdId]);

  const currentMember = household.members.find((m) => m.id === currentMemberId) ||
    household.members[0] || {
      id: currentMemberId,
      name: userEmail?.split('@')[0] || 'Tú',
      email: userEmail || '',
      role: 'member' as UserRole,
      avatarUrl: '',
      accentColor: '#2563eb',
      joinedAt: '',
    };
  const isAdmin = currentMember.role === 'admin';
  const pendingShoppingCount = shoppingList.filter((i) => !i.isChecked).length;
  const unreadNotifCount = notifications.filter((n) => !n.isRead).length;

  // ------------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------------

  const pushNotification = (n: Omit<HouseholdNotification, 'id' | 'isRead' | 'createdAt'>) => {
    const notification: HouseholdNotification = {
      ...n,
      id: newId(),
      isRead: false,
      createdAt: new Date().toISOString(),
    };
    setNotifications((prev) => [notification, ...prev]);
    return notification;
  };

  const saveSupermarkets = (next: SupermarketStore[]) => {
    setHousehold((prev) => ({ ...prev, supermarkets: next }));
    persist((client) => updateSupermarkets(client, householdId, next));
  };

  const handleCreateSupermarket = (newStore: Omit<SupermarketStore, 'id'>) => {
    if (
      baseHousehold.supermarkets.some(
        (s) => s.name.toLowerCase() === newStore.name.toLowerCase()
      )
    ) {
      return;
    }
    saveSupermarkets([...baseHousehold.supermarkets, { ...newStore, id: `sm-${newId()}` }]);
  };

  const handleDeleteSupermarket = (id: string) => {
    saveSupermarkets(baseHousehold.supermarkets.filter((s) => s.id !== id));
  };

  const updateSettings = (
    patch: Partial<
      Pick<
        Household,
        'monthlyBudget' | 'restockLookbackMonths' | 'restockAlertDays' | 'minPurchasesForPrediction'
      >
    >
  ) => {
    if (isCloud && !isAdmin) {
      showToast('Solo un administrador del hogar puede cambiar estos ajustes.');
      return;
    }
    setHousehold((prev) => ({ ...prev, ...patch }));
    persist((client) => updateHouseholdSettings(client, householdId, patch));
  };

  // Handler: Save a newly scanned or manually confirmed receipt
  const handleSavePurchase = (scanned: Purchase) => {
    // Fresh UUIDs so rows are valid for Postgres and stable across devices
    const purchaseId = newId();
    const newPurchase: Purchase = {
      ...scanned,
      id: purchaseId,
      householdId: householdId || scanned.householdId,
      items: scanned.items.map((it) => ({ ...it, id: newId(), purchaseId })),
    };
    setPurchases((prev) => [newPurchase, ...prev]);

    const newPantryEntries: PantryItem[] = newPurchase.items.map((item) => {
      const normInfo = normalizeReceiptProduct(item.normalizedName);
      return {
        id: newId(),
        name: item.normalizedName,
        canonicalName: item.canonicalName,
        category: item.category,
        storageLocation: normInfo.storageLocation,
        quantityLabel: `${item.quantity} ${item.unit} (${item.baseUnitQuantity.toLocaleString('es-CR')} ${item.baseUnit})`,
        baseQuantity: item.baseUnitQuantity,
        baseUnit: item.baseUnit,
        remainingPercentage: 100,
        purchasedDate: newPurchase.purchaseDate,
        estimatedExpiryDate: getIsoDaysFromNow(
          normInfo.shelfLifeDays,
          newPurchase.purchaseDate
        ),
        status: 'available',
        addedBy: newPurchase.createdBy,
      };
    });
    // Products already in the pantry because they were checked off the list are replaced, not duplicated
    const replacedPantryIds = new Set<string>();
    for (const entry of newPantryEntries) {
      const previous = findListPantryEntry(pantry, entry, replacedPantryIds);
      if (!previous) continue;
      replacedPantryIds.add(previous.id);
      entry.remainingPercentage = previous.remainingPercentage;
      entry.status = previous.status;
    }
    setPantry((prev) => [...newPantryEntries, ...prev.filter((p) => !replacedPantryIds.has(p.id))]);

    const matches = matchPurchasedItemsToShoppingList(shoppingList, newPurchase.items);
    const matchedIdMap = new Map(
      matches.map((m) => [m.shoppingListItemId, m.matchedReceiptItemName])
    );
    const checkedAt = new Date().toISOString();
    const crossedOff: ShoppingListItem[] = shoppingList
      .filter((item) => matchedIdMap.has(item.id))
      .map((item) => ({
        ...item,
        isChecked: true,
        checkedBy: newPurchase.createdBy,
        checkedAt,
        matchedPurchaseId: newPurchase.id,
        matchedReceiptItemName: matchedIdMap.get(item.id),
      }));

    let crossOffNotification: HouseholdNotification | null = null;
    if (crossedOff.length > 0) {
      const crossedMap = new Map(crossedOff.map((c) => [c.id, c]));
      const updatedList = shoppingList.map((item) => crossedMap.get(item.id) ?? item);
      setShoppingList(updatedList);
      setLastCrossedOffIds(crossedOff.map((c) => c.id));
      setAutoCrossOffSummary({
        id: newId(),
        purchaseId: newPurchase.id,
        supermarket: newPurchase.supermarket,
        crossedOffItems: matches,
        pendingCount: updatedList.filter((i) => !i.isChecked).length,
        timestamp: checkedAt,
      });
      crossOffNotification = pushNotification({
        type: 'auto_cross_off',
        title: `Autotachado: ${matches.length} productos en Lista de Compras`,
        message: `La factura de ${newPurchase.supermarket} coincidió con ${matches
          .map((m) => m.shoppingListName)
          .join(', ')}.`,
      });
    }

    // Order matters: list items reference the purchase through a foreign key
    persist(async (client) => {
      await insertPurchase(client, householdId, newPurchase);
      await deletePantryItems(client, [...replacedPantryIds]);
      await insertPantryItems(client, householdId, newPantryEntries);
      await updateShoppingItems(client, crossedOff);
      if (crossOffNotification) await insertNotification(client, householdId, crossOffNotification);
    });

    if (isCloud) {
      showToast(`Factura de ${newPurchase.supermarket} guardada`, 'success');
    }
  };

  // Handler: Save an edited receipt (same id; items replaced). Pantry entries are left as they are.
  const handleUpdatePurchase = (edited: Purchase) => {
    const original = purchases.find((p) => p.id === edited.id);
    const updated: Purchase = {
      ...edited,
      householdId: original?.householdId || householdId || edited.householdId,
      receiptImageUrl: original?.receiptImageUrl ?? edited.receiptImageUrl,
      items: edited.items.map((it) => ({ ...it, id: newId(), purchaseId: edited.id })),
    };
    setPurchases((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    setEditingPurchase(null);
    setInspectedPurchase(null);
    persist((client) => updatePurchase(client, householdId, updated));
    showToast(`Factura de ${updated.supermarket} actualizada`, 'success');
  };

  // Handler: Delete a receipt; list items it had crossed off stay checked but are unlinked
  const handleDeletePurchase = (target: Purchase) => {
    setPurchases((prev) => prev.filter((p) => p.id !== target.id));
    setShoppingList((prev) =>
      prev.map((item) =>
        item.matchedPurchaseId === target.id ? { ...item, matchedPurchaseId: undefined } : item
      )
    );
    setInspectedPurchase(null);
    persist((client) => deletePurchase(client, householdId, target.id));
    showToast(`Factura de ${target.supermarket} eliminada`, 'success');
  };

  const handleUndoAutoCrossOff = () => {
    if (lastCrossedOffIds.length === 0) return;
    const idSet = new Set(lastCrossedOffIds);
    const restored: ShoppingListItem[] = shoppingList
      .filter((item) => idSet.has(item.id))
      .map((item) => ({
        ...item,
        isChecked: false,
        checkedBy: undefined,
        checkedAt: undefined,
        matchedPurchaseId: undefined,
        matchedReceiptItemName: undefined,
      }));
    const restoredMap = new Map(restored.map((r) => [r.id, r]));
    setShoppingList((prev) => prev.map((item) => restoredMap.get(item.id) ?? item));
    setAutoCrossOffSummary(null);
    setLastCrossedOffIds([]);
    persist((client) => updateShoppingItems(client, restored));
  };

  const handleAddShoppingItems = (
    newItems: {
      name: string;
      canonicalName: string;
      category: GroceryCategory;
      quantity: number;
      unit: string;
      isPredicted?: boolean;
      predictedReason?: string;
      store?: string;
    }[]
  ) => {
    const createdAt = new Date().toISOString();
    const created: ShoppingListItem[] = newItems.map((it) => ({
      id: newId(),
      name: it.name,
      canonicalName: it.canonicalName,
      category: it.category,
      quantity: it.quantity,
      unit: it.unit,
      isChecked: false,
      isPredicted: Boolean(it.isPredicted),
      predictedReason: it.predictedReason,
      store: it.store,
      createdBy: currentMemberId,
      createdAt,
    }));
    setShoppingList((prev) => [...created, ...prev]);
    persist((client) => insertShoppingItems(client, householdId, created));
  };

  const handleToggleShoppingItem = (id: string) => {
    const item = shoppingList.find((it) => it.id === id);
    if (!item) return;
    const updated: ShoppingListItem = {
      ...item,
      isChecked: !item.isChecked,
      checkedBy: !item.isChecked ? currentMemberId : undefined,
      checkedAt: !item.isChecked ? new Date().toISOString() : undefined,
    };
    setShoppingList((prev) => prev.map((it) => (it.id === id ? updated : it)));

    // Checking an item off puts it in the pantry (same id, so unchecking can take it back out)
    const linkedPantry = pantry.find((p) => p.id === id && p.fromShoppingList);
    if (updated.isChecked && !pantry.some((p) => p.id === id)) {
      const entry = pantryEntryFromListItem(updated, currentMemberId);
      setPantry((prev) => [entry, ...prev]);
      persist(async (client) => {
        await updateShoppingItems(client, [updated]);
        await insertPantryItems(client, householdId, [entry]);
      });
      return;
    }
    if (!updated.isChecked && linkedPantry) {
      setPantry((prev) => prev.filter((p) => p.id !== id));
      persist(async (client) => {
        await updateShoppingItems(client, [updated]);
        await deletePantryItems(client, [id]);
      });
      return;
    }
    persist((client) => updateShoppingItems(client, [updated]));
  };

  const handleSetShoppingStore = (id: string, store: string | undefined) => {
    const item = shoppingList.find((it) => it.id === id);
    if (!item) return;
    const updated: ShoppingListItem = { ...item, store: store?.trim() || undefined };
    setShoppingList((prev) => prev.map((it) => (it.id === id ? updated : it)));
    persist((client) => updateShoppingItems(client, [updated]));
  };

  const handleDeleteShoppingItem = (id: string) => {
    setShoppingList((prev) => prev.filter((it) => it.id !== id));
    persist((client) => deleteShoppingItems(client, [id]));
  };

  const handleClearChecked = () => {
    const ids = shoppingList.filter((it) => it.isChecked).map((it) => it.id);
    setShoppingList((prev) => prev.filter((it) => !it.isChecked));
    persist((client) => deleteShoppingItems(client, ids));
  };

  // ------------------------------------------------------------------------
  // AI queue: requests saved while the AI was slow or down, retried in the background
  // ------------------------------------------------------------------------
  const aiQueue = useSyncExternalStore(subscribeAiQueue, getAiQueue);
  const myQueue = aiQueue.filter((e) => e.householdId === householdId);
  const queuedPending = myQueue.filter((e) => e.status === 'pending').length;
  const queuedReady = myQueue.filter((e) => e.kind === 'receipt' && e.status === 'ready');
  const addShoppingItemsRef = useRef(handleAddShoppingItems);
  addShoppingItemsRef.current = handleAddShoppingItems;
  const queueRunningRef = useRef(false);

  const processAiQueue = useCallback(async () => {
    if (queueRunningRef.current || !navigator.onLine || !isCloud) return;
    queueRunningRef.current = true;
    try {
      await loadAiQueue();
      for (const entry of getAiQueue()) {
        if (entry.householdId !== householdId || entry.status !== 'pending') continue;
        if (entry.kind === 'receipt') {
          const result = await scanReceiptImageWithAI(entry.dataUrl, entry.language);
          if (result.aiUnavailable) {
            updateAiQueueEntry(entry.id, { attempts: entry.attempts + 1 });
            break; // Still down: try again on the next round
          }
          updateAiQueueEntry(entry.id, { status: 'ready', result });
          showToast('Una factura de la cola está lista para revisar', 'success');
          notifyAiQueue('Canastica', 'Una factura en cola está lista para revisar.');
        } else {
          const items = await parseShoppingInputWithAI(entry.text, entry.language);
          if (items === null) {
            updateAiQueueEntry(entry.id, { attempts: entry.attempts + 1 });
            break;
          }
          addShoppingItemsRef.current(items.length > 0 ? items : parseShoppingInputLocally(entry.text));
          removeAiQueueEntry(entry.id);
          showToast('Se agregaron a la lista los productos que estaban en cola', 'success');
          notifyAiQueue('Canastica', 'Tu lista de compras en cola ya se agregó.');
        }
      }
    } finally {
      queueRunningRef.current = false;
    }
  }, [householdId, isCloud, showToast]);

  useEffect(() => {
    void processAiQueue();
    const timer = window.setInterval(() => void processAiQueue(), 60_000);
    const onOnline = () => void processAiQueue();
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [processAiQueue]);

  // New entries are tried right away (a minute later), not only on the next interval
  useEffect(() => {
    if (queuedPending === 0) return;
    const timer = window.setTimeout(() => void processAiQueue(), 45_000);
    return () => window.clearTimeout(timer);
  }, [queuedPending, processAiQueue]);

  const openQueuedReview = () => {
    const next = queuedReady[0];
    if (next?.kind !== 'receipt' || !next.result) return;
    setQueuedReview({ id: next.id, dataUrl: next.dataUrl, result: next.result });
  };

  const loadActivity = useMemo(
    () => (isCloud && sb ? () => fetchHouseholdActivity(sb, householdId) : null),
    [isCloud, sb, householdId]
  );

  const handleRestockFeedback = (
    canonicalName: string,
    feedback: 'ran_out' | 'still_have_some',
    pantryItemId?: string
  ) => {
    const prevMultiplier = feedbackMultipliers[canonicalName] ?? 1.0;
    const nextMultiplier =
      feedback === 'ran_out'
        ? Number((prevMultiplier * 1.18).toFixed(3))
        : Number(Math.max(0.5, prevMultiplier * 0.86).toFixed(3));
    setFeedbackMultipliers((prev) => ({ ...prev, [canonicalName]: nextMultiplier }));
    persist((client) => saveFeedbackMultiplier(client, householdId, canonicalName, nextMultiplier));

    const isTarget = (p: PantryItem) =>
      pantryItemId ? p.id === pantryItemId : p.canonicalName.toLowerCase() === canonicalName.toLowerCase();
    const changedPantry: PantryItem[] = pantry.filter(isTarget).map((p) =>
      feedback === 'ran_out'
        ? { ...p, remainingPercentage: 0, status: 'ran_out' }
        : {
            ...p,
            remainingPercentage: Math.min(100, p.remainingPercentage + 25),
            status: 'available',
          }
    );
    if (changedPantry.length > 0) {
      const changedMap = new Map(changedPantry.map((p) => [p.id, p]));
      setPantry((prev) => prev.map((p) => changedMap.get(p.id) ?? p));
      persist((client) => updatePantryItems(client, changedPantry));
    }

    if (feedback === 'ran_out') {
      const existsUnchecked = shoppingList.some(
        (s) =>
          !s.isChecked &&
          (s.canonicalName.toLowerCase() === canonicalName.toLowerCase() ||
            s.name.toLowerCase().includes(canonicalName.toLowerCase()))
      );

      if (!existsUnchecked) {
        const norm = normalizeReceiptProduct(canonicalName);
        handleAddShoppingItems([
          {
            name: canonicalName,
            canonicalName,
            category: norm.category,
            quantity: 1,
            unit: norm.baseUnit === 'ml' ? 'L' : norm.baseUnit === 'g' ? 'kg' : 'paq',
            isPredicted: true,
            predictedReason: `Marcado como "Se acabó" por ${currentMember.name} — modelo recalibrado`,
          },
        ]);
      }

      const n = pushNotification({
        type: 'restock_alert',
        title: `${canonicalName} marcado como Agotado`,
        message: `${currentMember.name} indicó que ${canonicalName} se acabó. Se actualizó la predicción y se añadió a la Lista de Compras.`,
      });
      persist((client) => insertNotification(client, householdId, n));
    }
  };

  const handleOpenNotifications = () => {
    setIsNotifOpen((o) => !o);
    if (unreadNotifCount > 0) {
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      persist((client) => markNotificationsRead(client, householdId));
    }
  };

  const handleResetDemoData = () => {
    localStorage.removeItem(DEMO_STATE_STORAGE_KEY);
    setHousehold(INITIAL_HOUSEHOLD);
    setCurrentMemberId('mem-alex');
    setPurchases(INITIAL_PURCHASES);
    setShoppingList(INITIAL_SHOPPING_LIST);
    setPantry(INITIAL_PANTRY);
    setSettlements(INITIAL_SETTLEMENTS);
    setNotifications(INITIAL_NOTIFICATIONS);
    setFeedbackMultipliers({});
    setAutoCrossOffSummary(null);
  };

  const lang = household.language;
  const cur = household.currency;

  const navItems: {
    id: TabId;
    label: string;
    shortLabel: string;
    subtitle: string;
    icon: typeof LayoutDashboard;
    badge?: number;
  }[] = [
    {
      id: 'dashboard',
      label: lang === 'es' ? 'Panel Principal' : 'Dashboard',
      shortLabel: lang === 'es' ? 'Inicio' : 'Home',
      subtitle: lang === 'es' ? 'Presupuesto, IA y compras' : 'Budget, AI & purchases',
      icon: LayoutDashboard,
    },
    {
      id: 'shopping-list',
      label: lang === 'es' ? 'Lista de Compras' : 'Shopping List',
      shortLabel: lang === 'es' ? 'Lista' : 'List',
      subtitle: lang === 'es' ? 'Compartida y autotachado' : 'Shared & auto-cross-off',
      icon: ShoppingCart,
      badge: pendingShoppingCount,
    },
    {
      id: 'restock-ai',
      label: lang === 'es' ? 'Reposición IA' : 'Restock AI',
      shortLabel: lang === 'es' ? 'Reponer' : 'Restock',
      subtitle: lang === 'es' ? 'Unidades base y consumo' : 'Base units & burn rate',
      icon: Activity,
      badge: predictions.filter((p) => p.estimatedDaysRemaining <= household.restockAlertDays)
        .length,
    },
    {
      id: 'pantry',
      label: lang === 'es' ? 'Despensa' : 'Pantry',
      shortLabel: lang === 'es' ? 'Despensa' : 'Pantry',
      subtitle: lang === 'es' ? 'Caducidad y existencias' : 'Expiry & stock tracker',
      icon: Refrigerator,
    },
    {
      id: 'analytics',
      label: lang === 'es' ? 'Analíticas y Comercios' : 'Analytics & Stores',
      shortLabel: lang === 'es' ? 'Gastos' : 'Spend',
      subtitle: lang === 'es' ? 'Precios, comercios y CSV' : 'Prices, stores & CSV',
      icon: BarChart3,
    },
    {
      id: 'household',
      label: lang === 'es' ? 'Hogar y Saldos' : 'Household & Splits',
      shortLabel: lang === 'es' ? 'Hogar' : 'Home',
      subtitle: lang === 'es' ? 'Miembros, roles y saldos' : 'Members, roles & splits',
      icon: Users,
    },
  ];

  const activeNavMeta = navItems.find((n) => n.id === activeTab) || navItems[0];

  // Plain module state (no re-render): tells problem reports where the user is
  setReportScreenContext({
    screen: activeNavMeta.label,
    openPanel: editingPurchase
      ? 'Editar factura'
      : isScannerOpen
      ? 'Escáner de facturas'
      : inspectedPurchase
      ? 'Detalle de factura'
      : isAssistantOpen
      ? 'Asistente'
      : isAccountOpen
      ? 'Menú de cuenta'
      : null,
    householdId: isCloud ? householdId : null,
    language: lang,
  });

  const monthPrefix = getCurrentMonthPrefix();
  const monthSpent = purchases
    .filter((p) => p.purchaseDate.startsWith(monthPrefix))
    .reduce((s, p) => s + p.totalAmount, 0);
  const monthPct = Math.min(
    100,
    Math.round((monthSpent / Math.max(1, household.monthlyBudget)) * 100)
  );

  const selectTab = (tab: TabId) => {
    setActiveTab(tab);
    setIsNotifOpen(false);
    document.getElementById('main-scroll')?.scrollTo({ top: 0 });
  };

  // ------------------------------------------------------------------------
  // Loading / error screens (cloud only)
  // ------------------------------------------------------------------------

  if (isCloud && isLoading) {
    return (
      <div className="h-dvh w-full flex flex-col items-center justify-center gap-3 bg-[var(--bg-canvas)] text-[var(--text-primary)]">
        <BrandMark className="w-12 h-12 rounded-2xl" />
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando tu hogar…
        </div>
      </div>
    );
  }

  if (isCloud && loadError && !baseHousehold.id) {
    return (
      <div className="h-dvh w-full flex items-center justify-center p-4 bg-[var(--bg-canvas)] text-[var(--text-primary)]">
        <div className="liquid-glass rounded-2xl p-5 max-w-sm w-full space-y-3 text-center">
          <AlertTriangle className="w-8 h-8 mx-auto text-amber-500" />
          <p className="text-base font-bold">No pudimos cargar tu hogar</p>
          <p className="text-sm text-[var(--text-muted)]">{loadError}</p>
          <div className="flex gap-2">
            <button
              onClick={onSignOut}
              className="flex-1 min-h-[44px] rounded-xl liquid-glass-subtle liquid-glass-interactive text-sm font-semibold"
            >
              Cerrar sesión
            </button>
            <button
              onClick={() => void reload()}
              className="flex-1 min-h-[44px] rounded-xl liquid-lens-btn text-sm font-bold flex items-center justify-center gap-1.5"
            >
              <RefreshCw className="w-4 h-4" /> Reintentar
            </button>
          </div>
        </div>
      </div>
    );
  }

  const syncBadge = !isOnline ? (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300">
      <WifiOff className="w-3 h-3" /> {lang === 'es' ? 'Sin conexión' : 'Offline'}
    </span>
  ) : !isCloud ? (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-300">
      {lang === 'es' ? 'Modo prueba' : 'Demo'}
    </span>
  ) : (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
        realtimeConnected
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'bg-slate-500/10 text-[var(--text-muted)]'
      }`}
    >
      {isSyncing ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <span
          className={`w-1.5 h-1.5 rounded-full ${realtimeConnected ? 'bg-emerald-500' : 'bg-slate-400'}`}
        />
      )}
      {realtimeConnected ? (lang === 'es' ? 'En vivo' : 'Live') : lang === 'es' ? 'Conectando' : 'Connecting'}
    </span>
  );

  return (
    <div className="h-dvh w-full overflow-hidden flex bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      {/* ====================================================================
          Desktop Sidebar
          ==================================================================== */}
      <aside className="hidden lg:flex lg:w-60 shrink-0 flex-col justify-between border-r border-[var(--glass-border)] bg-[var(--bg-sidebar)] p-3 h-full select-none">
        <div className="space-y-4">
          <button
            onClick={() => selectTab('dashboard')}
            className="flex items-center gap-2.5 min-w-0 px-1.5 pt-0.5 text-left"
          >
            <BrandMark className="w-9 h-9 rounded-xl" />
            <div className="min-w-0">
              <h1 className="text-sm font-extrabold tracking-tight">Canastica</h1>
              <p className="text-xs text-[var(--text-muted)] truncate">{household.name}</p>
            </div>
          </button>

          <button
            onClick={() => setIsScannerOpen(true)}
            className="w-full liquid-lens-btn py-2.5 px-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2"
          >
            <Camera className="w-4 h-4" />
            <span>{lang === 'es' ? 'Escanear factura' : 'Scan receipt'}</span>
          </button>

          <nav className="space-y-0.5">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => selectTab(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`w-full px-2.5 py-2 rounded-xl text-left flex items-center justify-between gap-2 transition ${
                    isActive
                      ? 'bg-avocado-600/10 text-avocado-600 dark:bg-avocado-500/15 dark:text-avocado-400 font-bold'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--glass-bg-hover)] font-medium'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Icon
                      className={`w-4 h-4 shrink-0 ${
                        isActive ? 'text-avocado-600 dark:text-avocado-400' : 'text-[var(--text-muted)]'
                      }`}
                    />
                    <span className="text-sm truncate">{item.label}</span>
                  </div>
                  {item.badge ? (
                    <span
                      className={`px-1.5 rounded-full text-[11px] font-bold shrink-0 ${
                        isActive
                          ? 'bg-avocado-600 text-white'
                          : 'bg-slate-200 dark:bg-slate-800 text-[var(--text-secondary)]'
                      }`}
                    >
                      {item.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="space-y-2.5 pt-3 border-t border-[var(--glass-border)]">
          <div className="liquid-glass-subtle rounded-xl p-2.5 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-[var(--text-secondary)]">
                {lang === 'es' ? 'Presupuesto' : 'Budget'} {monthName(monthPrefix, lang, true)}
              </span>
              <span className="font-bold text-avocado-600 dark:text-avocado-400">{monthPct}%</span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-avocado-600 transition-all duration-500"
                style={{ width: `${monthPct}%` }}
              />
            </div>
            <div className="flex justify-between text-[11px] text-[var(--text-muted)] font-mono">
              <span>{formatCurrency(monthSpent, cur, true)}</span>
              <span>{formatCurrency(household.monthlyBudget, cur, true)}</span>
            </div>
          </div>

          <button
            onClick={() => setIsAccountOpen(true)}
            className="w-full liquid-glass-subtle liquid-glass-interactive p-2 rounded-xl flex items-center gap-2 text-left"
          >
            <Avatar
              name={currentMember.name}
              src={currentMember.avatarUrl}
              color={currentMember.accentColor}
              className="w-8 h-8"
            />
            <div className="min-w-0">
              <span className="text-sm font-bold block truncate">{currentMember.name}</span>
              <span className="text-[11px] text-avocado-600 dark:text-avocado-400 font-semibold block">
                {currentMember.role === 'admin' ? 'Admin' : 'Miembro'}
              </span>
            </div>
          </button>
        </div>
      </aside>

      {/* ====================================================================
          Main Column
          ==================================================================== */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        <header className="shrink-0 z-30 border-b border-[var(--glass-border)] bg-[var(--bg-sidebar)] pt-[env(safe-area-inset-top)]">
          <div className="h-14 px-3 sm:px-4 lg:px-5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <BrandMark className="lg:hidden w-8 h-8 rounded-lg" />
              <div className="min-w-0">
                <h2 className="text-base font-bold tracking-tight truncate leading-tight">
                  {activeNavMeta.label}
                </h2>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="lg:hidden text-xs text-[var(--text-muted)] truncate">
                    {household.name}
                  </span>
                  <span className="hidden lg:inline text-xs text-[var(--text-muted)] truncate">
                    {activeNavMeta.subtitle}
                  </span>
                  <span className="hidden sm:inline-flex">{syncBadge}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
              {/* Quick display toggles on larger screens; on phones they live in the account sheet */}
              <div className="hidden md:flex items-center gap-1.5">
                <button
                  onClick={() => updatePrefs({ currency: cur === 'CRC' ? 'USD' : 'CRC' })}
                  className="liquid-glass-subtle liquid-glass-interactive h-9 px-2.5 rounded-lg text-xs font-bold text-avocado-600 dark:text-avocado-400"
                  title="Alternar moneda"
                >
                  {cur === 'CRC' ? '₡ CRC' : '$ USD'}
                </button>
                <button
                  onClick={() => updatePrefs({ language: lang === 'es' ? 'en' : 'es' })}
                  className="liquid-glass-subtle liquid-glass-interactive h-9 px-2.5 rounded-lg text-xs font-semibold flex items-center gap-1"
                  title="Cambiar idioma"
                >
                  <Globe className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  <span className="uppercase">{lang}</span>
                </button>
                <button
                  onClick={onToggleTheme}
                  className="liquid-glass-subtle liquid-glass-interactive w-9 h-9 rounded-lg flex items-center justify-center"
                  aria-label={theme === 'light' ? 'Modo oscuro' : 'Modo claro'}
                >
                  {theme === 'light' ? (
                    <Moon className="w-4 h-4 text-slate-700" />
                  ) : (
                    <Sun className="w-4 h-4 text-amber-400" />
                  )}
                </button>
              </div>

              <button
                onClick={() => setIsAssistantOpen(true)}
                className="liquid-glass-subtle liquid-glass-interactive h-10 sm:h-9 min-w-10 sm:min-w-9 px-2.5 rounded-xl sm:rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 text-avocado-600 dark:text-avocado-400"
                aria-label="Abrir asistente IA"
              >
                <Bot className="w-4 h-4" />
                <span className="hidden md:inline">{lang === 'es' ? 'Asistente' : 'Assistant'}</span>
              </button>

              <div className="relative">
                <button
                  onClick={handleOpenNotifications}
                  className="w-10 h-10 sm:w-9 sm:h-9 rounded-xl sm:rounded-lg liquid-glass-subtle liquid-glass-interactive relative flex items-center justify-center"
                  aria-label="Notificaciones"
                  aria-expanded={isNotifOpen}
                >
                  <Bell className="w-4 h-4" />
                  {unreadNotifCount > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center">
                      {unreadNotifCount > 9 ? '9+' : unreadNotifCount}
                    </span>
                  )}
                </button>

                {isNotifOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-40 bg-slate-900/20 sm:bg-transparent"
                      onClick={() => setIsNotifOpen(false)}
                    />
                    <div className="fixed left-2 right-2 top-[calc(env(safe-area-inset-top)+60px)] sm:absolute sm:left-auto sm:top-auto sm:right-0 sm:mt-2 sm:w-96 liquid-glass-elevated rounded-2xl p-3 space-y-2 z-50 animate-spring-in">
                      <div className="flex items-center justify-between border-b border-[var(--glass-border)] pb-2">
                        <span className="text-sm font-bold">Notificaciones</span>
                        <button
                          onClick={() => setIsNotifOpen(false)}
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                          aria-label="Cerrar"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="space-y-1.5 max-h-[60vh] overflow-y-auto no-scrollbar">
                        {notifications.length === 0 && (
                          <p className="text-sm text-[var(--text-muted)] text-center py-6">
                            No tienes notificaciones.
                          </p>
                        )}
                        {notifications.map((n) => (
                          <div key={n.id} className="liquid-glass-subtle rounded-xl p-3 space-y-0.5">
                            <div className="font-bold text-avocado-600 dark:text-avocado-400 text-sm">
                              {n.title}
                            </div>
                            <p className="text-sm text-[var(--text-secondary)] leading-snug">
                              {n.message}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>

              <button
                onClick={() => setIsAccountOpen(true)}
                className="lg:hidden w-10 h-10 rounded-xl flex items-center justify-center"
                aria-label="Cuenta y ajustes"
              >
                <Avatar
                  name={currentMember.name}
                  src={currentMember.avatarUrl}
                  color={currentMember.accentColor}
                  className="w-8 h-8"
                />
              </button>
            </div>
          </div>
        </header>

        <main
          id="main-scroll"
          className="flex-1 w-full overflow-y-auto overflow-x-hidden overscroll-contain p-3 sm:p-4 pb-[calc(env(safe-area-inset-bottom)+150px)] lg:pb-6"
        >
          <div className="w-full max-w-7xl mx-auto">
            {(queuedPending > 0 || queuedReady.length > 0) && (
              <div className="mb-3 liquid-glass rounded-xl px-3 py-2 flex flex-wrap items-center justify-between gap-2 border border-amber-500/30">
                <span className="text-xs font-semibold">
                  {queuedReady.length > 0
                    ? `${queuedReady.length} ${queuedReady.length === 1 ? 'factura lista' : 'facturas listas'} para revisar`
                    : `${queuedPending} en cola esperando a la IA`}
                  {queuedReady.length > 0 && queuedPending > 0 && (
                    <span className="text-[var(--text-muted)] font-normal"> · {queuedPending} en espera</span>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  {queuedReady.length > 0 && (
                    <button
                      onClick={openQueuedReview}
                      className="liquid-lens-btn px-3 py-1 rounded-lg text-xs font-bold"
                    >
                      Revisar
                    </button>
                  )}
                  {queuedReady.length > 0 && (
                    <button
                      onClick={() => removeAiQueueEntry(queuedReady[0].id)}
                      className="text-[11px] text-rose-600 dark:text-rose-400 font-bold hover:underline"
                    >
                      Descartar
                    </button>
                  )}
                </div>
              </div>
            )}
            {activeTab === 'dashboard' && (
              <DashboardView
                household={household}
                purchases={purchases}
                predictions={predictions}
                onQuickAddShoppingItem={(item) => handleAddShoppingItems([item])}
                onRestockFeedback={(canonicalName, fb) => handleRestockFeedback(canonicalName, fb)}
                onInspectPurchase={(p) => setInspectedPurchase(p)}
                onOpenScanner={() => setIsScannerOpen(true)}
                onNavigateTab={(tab) => selectTab(tab as TabId)}
                onOpenAssistantWithPrompt={(prompt) => {
                  setAssistantInitialPrompt(prompt);
                  setIsAssistantOpen(true);
                }}
              />
            )}

            {activeTab === 'shopping-list' && (
              <ShoppingListView
                household={household}
                householdId={householdId}
                items={shoppingList}
                purchases={purchases}
                predictions={predictions}
                autoCrossOffSummary={autoCrossOffSummary}
                onAddParsedItems={handleAddShoppingItems}
                onToggleItem={handleToggleShoppingItem}
                onSetStore={handleSetShoppingStore}
                onDeleteItem={handleDeleteShoppingItem}
                onClearChecked={handleClearChecked}
                onUndoAutoCrossOff={handleUndoAutoCrossOff}
                onOpenScanner={() => setIsScannerOpen(true)}
              />
            )}

            {activeTab === 'restock-ai' && (
              <RestockPredictionView
                household={household}
                predictions={predictions}
                learningProducts={learningProducts}
                onUpdateSettings={updateSettings}
                onRestockFeedback={(canonicalName, fb) => handleRestockFeedback(canonicalName, fb)}
                onAddPredictedToList={(item) => handleAddShoppingItems([item])}
              />
            )}

            {activeTab === 'pantry' && (
              <PantryView
                household={household}
                pantryItems={pantry}
                onPantryFeedback={(pantryItemId, canonicalName, fb) =>
                  handleRestockFeedback(canonicalName, fb, pantryItemId)
                }
              />
            )}

            {activeTab === 'analytics' && (
              <AnalyticsAndPricesView
                household={household}
                purchases={purchases}
                onCreateSupermarket={handleCreateSupermarket}
                onDeleteSupermarket={handleDeleteSupermarket}
              />
            )}

            {activeTab === 'household' && (
              <HouseholdAndSplitsView
                mode={isCloud ? 'cloud' : 'demo'}
                loadActivity={loadActivity}
                household={household}
                currentMemberId={currentMemberId}
                purchases={purchases}
                settlements={settlements}
                onSwitchCurrentMember={(id) => setCurrentMemberId(id)}
                onUpdateMonthlyBudget={(newBudget) => updateSettings({ monthlyBudget: newBudget })}
                onUpdateMemberRole={(memberId, role: UserRole) => {
                  if (isCloud && !isAdmin) {
                    showToast('Solo un administrador puede cambiar roles.');
                    return;
                  }
                  if (
                    isCloud &&
                    role === 'member' &&
                    household.members.filter((m) => m.role === 'admin').length <= 1 &&
                    household.members.find((m) => m.id === memberId)?.role === 'admin'
                  ) {
                    showToast('El hogar necesita al menos un administrador.');
                    return;
                  }
                  setHousehold((prev) => ({
                    ...prev,
                    members: prev.members.map((m) => (m.id === memberId ? { ...m, role } : m)),
                  }));
                  persist((client) => updateMemberRole(client, householdId, memberId, role));
                }}
                onAddMember={(name, email) =>
                  setHousehold((prev) => ({
                    ...prev,
                    members: [
                      ...prev.members,
                      {
                        id: `mem-${newId()}`,
                        name,
                        email,
                        role: 'member',
                        avatarUrl: '',
                        accentColor: '#2563eb',
                        joinedAt: getTodayIso(),
                      },
                    ],
                  }))
                }
                onJoinHousehold={onJoinHousehold}
                onCreateSupermarket={handleCreateSupermarket}
                onToggleItemShared={(purchaseId, itemId) => {
                  const target = purchases
                    .find((p) => p.id === purchaseId)
                    ?.items.find((it) => it.id === itemId);
                  if (!target) return;
                  const nextShared = !target.isShared;
                  setPurchases((prev) =>
                    prev.map((p) =>
                      p.id !== purchaseId
                        ? p
                        : {
                            ...p,
                            items: p.items.map((it) =>
                              it.id === itemId ? { ...it, isShared: nextShared } : it
                            ),
                          }
                    )
                  );
                  persist((client) => setPurchaseItemShared(client, itemId, nextShared));
                }}
                onRecordSettlement={(fromMemberId, toMemberId, amount) => {
                  const settlement: ExpenseSettlement = {
                    id: newId(),
                    fromMemberId,
                    toMemberId,
                    amount,
                    note: 'Liquidación registrada en Canastica',
                    settledAt: new Date().toISOString(),
                  };
                  setSettlements((prev) => [settlement, ...prev]);
                  persist((client) => insertSettlement(client, householdId, settlement));
                }}
              />
            )}
          </div>
        </main>
      </div>

      {/* Mobile Floating Scan Button (sits above the tab bar) */}
      <button
        onClick={() => setIsScannerOpen(true)}
        className="lg:hidden fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+84px)] z-40 liquid-lens-btn h-12 pl-4 pr-5 rounded-full text-white font-bold text-sm flex items-center gap-2 shadow-lg shadow-avocado-600/30"
        aria-label={lang === 'es' ? 'Escanear factura' : 'Scan receipt'}
      >
        <Camera className="w-5 h-5" />
        <span>{lang === 'es' ? 'Escanear' : 'Scan'}</span>
      </button>

      {/* Mobile Bottom Tab Bar */}
      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-[var(--glass-border)] liquid-glass-elevated rounded-none pb-[env(safe-area-inset-bottom)]"
        aria-label="Secciones"
      >
        <div className="flex items-stretch justify-around max-w-xl mx-auto px-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => selectTab(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`flex-1 min-w-0 h-16 flex flex-col items-center justify-center gap-1 text-[11px] font-semibold transition relative ${
                  isActive ? 'text-avocado-600 dark:text-avocado-400' : 'text-[var(--text-muted)]'
                }`}
              >
                <span
                  className={`flex items-center justify-center w-12 h-7 rounded-full transition ${
                    isActive ? 'bg-avocado-600/12 dark:bg-avocado-500/20' : ''
                  }`}
                >
                  <Icon className="w-5 h-5" />
                </span>
                <span className="truncate max-w-full px-0.5">{item.shortLabel}</span>
                {item.badge ? (
                  <span className="absolute top-1.5 left-1/2 ml-2 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center">
                    {item.badge > 9 ? '9+' : item.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Toast */}
      {toast && (
        <div
          role={toast.kind === 'error' ? 'alert' : 'status'}
          className="fixed z-[70] left-3 right-3 sm:left-auto sm:right-5 sm:w-96 top-[calc(env(safe-area-inset-top)+64px)] animate-spring-in"
        >
          <div
            className={`rounded-2xl px-4 py-3 text-sm font-semibold flex items-start gap-2.5 shadow-xl ${
              toast.kind === 'error'
                ? 'bg-rose-600 text-white'
                : 'bg-emerald-600 text-white'
            }`}
          >
            {toast.kind === 'error' ? (
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            )}
            <span className="flex-1">{toast.text}</span>
            <button onClick={() => setToast(null)} aria-label="Cerrar" className="-mr-1">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Modals & Drawers */}
      <ReceiptScannerModal
        key={editingPurchase ? `edit-${editingPurchase.id}` : queuedReview ? `queued-${queuedReview.id}` : 'new'}
        isOpen={isScannerOpen || Boolean(editingPurchase) || Boolean(queuedReview)}
        onClose={() => {
          setIsScannerOpen(false);
          setEditingPurchase(null);
          setQueuedReview(null);
        }}
        householdId={householdId}
        queuedScan={queuedReview}
        editingPurchase={editingPurchase}
        onUpdatePurchase={handleUpdatePurchase}
        members={household.members}
        currentMemberId={currentMemberId}
        categories={household.categories.map((c) => c.name)}
        supermarkets={household.supermarkets}
        currency={cur}
        language={lang}
        purchaseHistory={purchases}
        onCreateSupermarket={handleCreateSupermarket}
        onSavePurchase={handleSavePurchase}
      />

      <ReceiptDetailModal
        purchase={inspectedPurchase}
        members={household.members}
        currency={cur}
        onClose={() => setInspectedPurchase(null)}
        onEdit={(p) => {
          setInspectedPurchase(null);
          setEditingPurchase(p);
        }}
        onDelete={handleDeletePurchase}
      />

      <AIAssistantDrawer
        isOpen={isAssistantOpen}
        onClose={() => setIsAssistantOpen(false)}
        initialPrompt={assistantInitialPrompt}
        onClearInitialPrompt={() => setAssistantInitialPrompt(null)}
        household={household}
        purchases={purchases}
        shoppingList={shoppingList}
        pantry={pantry}
        predictions={predictions}
      />

      <AccountSheet
        isOpen={isAccountOpen}
        onClose={() => setIsAccountOpen(false)}
        mode={isCloud ? 'cloud' : 'demo'}
        member={currentMember}
        householdName={household.name}
        householdId={householdId}
        memberships={memberships}
        currency={cur}
        language={lang}
        theme={theme}
        syncBadge={syncBadge}
        onChangeCurrency={(c) => updatePrefs({ currency: c })}
        onChangeLanguage={(l) => updatePrefs({ language: l })}
        onToggleTheme={onToggleTheme}
        onSwitchHousehold={onSwitchHousehold}
        onSwitchDemoMember={
          isCloud
            ? undefined
            : () => {
                const idx = household.members.findIndex((m) => m.id === demoMemberId);
                const next = household.members[(idx + 1) % household.members.length];
                if (next) setCurrentMemberId(next.id);
              }
        }
        onResetDemoData={handleResetDemoData}
        onSignOut={onSignOut}
        onExitDemo={onExitDemo}
      />
    </div>
  );
}

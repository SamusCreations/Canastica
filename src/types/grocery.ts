// ============================================================================
// Canastica Domain Types
// ============================================================================

export type UserRole = 'admin' | 'member';
export type BaseUnit = 'ml' | 'g' | 'units';
export type StorageLocation = 'Fridge' | 'Freezer' | 'Dry Pantry' | 'Household';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type CurrencyCode = 'CRC' | 'USD';
export type LanguageCode = 'es' | 'en';

export type GroceryCategory =
  | 'Dairy & Eggs'
  | 'Meat & Poultry'
  | 'Produce'
  | 'Bakery'
  | 'Pantry Staples'
  | 'Beverages'
  | 'Snacks'
  | 'Cleaning & Home'
  | 'Personal Care';

export type SupermarketType =
  | 'Cadena Nacional'
  | 'Club Mayorista'
  | 'Abastecedor / Pulpería'
  | 'Feria del Agricultor'
  | 'Carnicería / Especialidad'
  | 'Otro';

export interface SupermarketStore {
  id: string;
  name: string;
  type: SupermarketType;
  color: string;
  locationHint?: string;
  isCustom?: boolean;
}

export interface HouseholdMember {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatarUrl: string;
  accentColor: string;
  joinedAt: string;
}

export interface CategoryBudget {
  name: GroceryCategory;
  icon: string;
  color: string;
  monthlyAllocation: number; // Stored in CRC
  aisleOrder: number;
}

export interface Household {
  id: string;
  name: string;
  inviteCode: string;
  monthlyBudget: number; // Stored in CRC (default e.g. 580,000)
  currency: CurrencyCode;
  language: LanguageCode;
  restockLookbackMonths: 3 | 6 | 12;
  restockAlertDays: number;
  minPurchasesForPrediction: number;
  members: HouseholdMember[];
  categories: CategoryBudget[];
  supermarkets: SupermarketStore[];
}

export interface PurchaseItem {
  id: string;
  purchaseId: string;
  rawReceiptName: string; // e.g., "LCH DOS PIN 1L"
  normalizedName: string; // e.g., "Leche Dos Pinos 1L"
  canonicalName: string;  // e.g., "Leche"
  category: GroceryCategory;
  quantity: number;       // e.g., 2
  unit: string;           // e.g., "caja 900ml" or "L" or "gal"
  baseUnitQuantity: number; // total normalized quantity in ml, g, or units (e.g., 1800)
  baseUnit: BaseUnit;     // 'ml' | 'g' | 'units'
  unitPrice: number;      // in CRC
  totalPrice: number;     // in CRC
  isShared: boolean;      // Shared vs. Personal item for Expense Splitting
  assignedTo?: string;    // Member who owns a personal item (defaults to the payer)
  createdBy: string;      // Member ID
  purchaseDate: string;   // ISO Date YYYY-MM-DD
  supermarket: string;
  estimatedShelfLifeDays?: number;
  storageLocation?: StorageLocation;
}

export interface Purchase {
  id: string;
  householdId: string;
  supermarket: string;
  purchaseDate: string; // YYYY-MM-DD
  createdBy: string;    // Member ID
  subtotal: number;     // in CRC
  discounts: number;    // in CRC
  taxes: number;        // in CRC
  totalAmount: number;  // in CRC
  receiptImageUrl: string;
  notes?: string;
  items: PurchaseItem[];
}

export interface ShoppingListItem {
  id: string;
  name: string;
  canonicalName: string;
  category: GroceryCategory;
  quantity: number;
  unit: string;
  isChecked: boolean;
  checkedBy?: string;
  checkedAt?: string;
  matchedPurchaseId?: string;
  matchedReceiptItemName?: string;
  isPredicted: boolean;
  predictedReason?: string;
  store?: string;         // Where the user plans to buy it (supermarket name)
  createdBy: string;
  createdAt: string;
}

export interface PantryItem {
  id: string;
  name: string;
  canonicalName: string;
  category: GroceryCategory;
  storageLocation: StorageLocation;
  quantityLabel: string;
  baseQuantity: number;
  baseUnit: BaseUnit;
  remainingPercentage: number; // 0 to 100
  purchasedDate: string;
  estimatedExpiryDate: string;
  status: 'available' | 'running_low' | 'ran_out';
  addedBy: string;
  /** Added by checking off a shopping list item (same id); replaced when a receipt brings it */
  fromShoppingList?: boolean;
}

export interface HistoricalIntervalPoint {
  purchaseDate: string;
  nextPurchaseDate: string;
  daysElapsed: number;
  baseQuantityBought: number;
  displayQuantity: string;
  dailyRateInInterval: number;
  recencyWeight: number;
}

export interface RestockPrediction {
  canonicalName: string;
  category: GroceryCategory;
  baseUnit: BaseUnit;
  weightedDailyRate: number;          // Base units per day (e.g. 270 ml/day)
  lastPurchaseDate: string;           // e.g. 5 days ago
  daysSinceLastPurchase: number;
  lastPurchaseBaseQty: number;        // e.g. 1800 ml
  lastPurchaseDisplayQty: string;     // e.g. "1.8 L (1,800 ml)"
  expectedDurationDays: number;       // e.g. 1800 / 270 = 6.7 days
  estimatedDaysRemaining: number;     // e.g. 1.7 -> ~2 days
  confidenceLevel: ConfidenceLevel;   // 'high' | 'medium' | 'low'
  confidenceScore: number;            // 0-100
  purchaseCount: number;              // e.g. 5
  groupedVariants: string[];
  intervals: HistoricalIntervalPoint[];
  feedbackMultiplier: number;
  aiExplanation: string;
  isRunningLowSoon: boolean;
}

export interface UnpredictedProductProgress {
  canonicalName: string;
  category: GroceryCategory;
  purchaseCount: number;
  requiredCount: number;
  groupedVariants: string[];
  lastPurchaseDate: string;
}

export interface AutoCrossOffSummary {
  id: string;
  purchaseId: string;
  supermarket: string;
  crossedOffItems: {
    shoppingListItemId: string;
    shoppingListName: string;
    matchedReceiptItemName: string;
  }[];
  pendingCount: number;
  timestamp: string;
}

export interface ExpenseSettlement {
  id: string;
  fromMemberId: string;
  toMemberId: string;
  amount: number; // in CRC
  note: string;
  settledAt: string;
  evidencePath?: string; // Proof of payment in the private settlement-evidence bucket
}

export interface HouseholdNotification {
  id: string;
  type: 'restock_alert' | 'price_spike' | 'expiry_warning' | 'auto_cross_off' | 'budget_alert';
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

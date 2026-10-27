# GlassCart — iOS 26 Liquid Glass Household Grocery & Receipt Intelligence

GlassCart is a modern, multi-user household grocery, receipt OCR, shared shopping list, virtual pantry, and AI restock prediction web application designed with Apple's **iOS 26 "Liquid Glass"** aesthetic and powered by **Gemini 2.5 Multimodal AI** and **Supabase**.

## ✨ Key Features

- **🎨 iOS 26 Liquid Glass UI**: Translucent frosted surfaces (`backdrop-filter: blur(28px) saturate(190%)`), luminous specular top-left rims, layered depth, ambient refractive orbs, spring-physics animations, and full **Dark & Light Mode** support.
- **👥 Multi-User Households & Roles**:
  - **Admin** (manages monthly budget, category allocations, and member roles) and **Member** roles.
  - Invite code (`GLS-829`) and shareable link support.
  - Every purchase, receipt, shopping list item, and pantry entry tracks and displays the creator's avatar.
- **🧾 AI Multimodal Receipt Scanner**:
  - Camera capture on mobile & drag-and-drop on desktop, plus 1-tap demo receipts.
  - Extracts supermarket, date, line items, discounts, taxes, and grand total.
  - Normalizes abbreviated receipt codes (`"LCH DOS PIN 1L"` → `"Milk Dos Pinos 1L"`) and assigns canonical product groups & categories.
  - Side-by-side glass confirmation card with live sum validation (`Sum(items) - Discounts + Taxes == Grand Total`) and discrepancy warnings.
  - Friendly blurry/unreadable photo detection with photography tips.
- **✅ Realtime Shared Shopping List**:
  - Natural language input (`"2 liters of milk, whole wheat bread, and laundry detergent"`), parsed by Gemini into structured items by aisle.
  - **Semantic Auto-Cross-Off with Undo**: Automatically crosses off matching shopping list items when a receipt is saved, even when names differ (`"Milk (2 Liters)"` ↔ `"Milk Dos Pinos 1L"`).
- **🔮 AI Restock Prediction Engine**:
  - Normalizes all historical quantities to base units (`ml`, `g`, or `units`) so different package sizes (`1 Gal = 3,785 ml` vs. `2 × 900 ml = 1,800 ml`) are directly comparable.
  - Computes a recency-weighted daily consumption rate (`baseUnits / day`) and scales the expected duration strictly to the **last quantity purchased**.
  - Groups brand variants under canonical products, requires a configurable minimum purchase count (default `3`), and displays confidence levels (`High`, `Medium`, `Low`).
  - Interactive **"Ran Out"** and **"Still Have Some"** feedback buttons that immediately recalibrate the model.
- **📊 Dashboard, Analytics, Price History, Supermarket Comparator, Expense Splitting & Conversational AI**:
  - Animated Liquid Glass Budget Ring, Category Bars, AI Insights Card, and Quick-Add Chips.
  - Unit-normalized Price History & Spike Alerts + Supermarket Comparator matrix.
  - Shared vs. Personal Expense Splitting with optimal `"Who Owes Whom"` settlements.
  - Virtual Pantry with AI-estimated expiration dates.
  - Conversational Gemini Assistant + Date-range CSV/Excel Export.

## 🚀 Running Locally

```bash
npm install
cp .env.example .env   # fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

Without Supabase credentials the app still opens: tap **"Probar con datos de ejemplo"** on the login screen to use the local demo household (saved only in that browser).

## 🔐 Accounts, households & data (Supabase)

- **Login**: email + password with Supabase Auth (sign up, sign in, password reset). A `profiles` row is created automatically for every new user.
- **Households**: after the first login the user creates a household (becomes **admin**) or joins one with an invite code. Invite links look like `https://your-app/?join=GLS-XXXXX`; opening one takes a new user straight to the join step.
- **Data**: purchases, receipt items, shopping list, pantry, restock feedback, settlements and notifications are read from and written to Supabase. Changes from other members arrive in real time (Supabase Realtime) and the app also refreshes when the phone tab comes back to the foreground.
- **Permissions (RLS)**: members only see their own households. Only admins can change the monthly budget, restock settings and member roles; any member can add supermarkets.
- Currency, language and theme are per-device preferences.

## ☁️ Deploying Supabase Backend & Edge Functions

1. Apply the PostgreSQL schema, Row Level Security (RLS) policies, Storage bucket, Realtime tables, `pg_cron` schedule and the auth/onboarding functions (enable the **pg_cron** extension in the dashboard first):
   ```bash
   supabase db push
   ```
   (See `supabase/migrations/`)
2. In **Authentication → URL Configuration**, set the *Site URL* to where the app is hosted and add it to *Redirect URLs* (needed for email confirmation and password reset links). For local testing add `http://localhost:5173`.
3. Deploy the `assistant` Edge Function and set its secrets (the function only answers signed-in users):
   ```bash
   supabase secrets set GEMINI_API_KEY=your_gemini_key
   # Web origins allowed to call the function (comma separated). Without it only localhost / LAN IPs work.
   supabase secrets set ALLOWED_ORIGINS=https://your-app-domain.com
   # Optional: model fallback order
   supabase secrets set GEMINI_MODELS=gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite
   supabase functions deploy assistant
   ```
   (See `supabase/functions/assistant/index.ts`. The old `gemini-ai` function can be deleted:
   `supabase functions delete gemini-ai`.)

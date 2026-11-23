import React, { useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Home,
  Inbox,
  LifeBuoy,
  Lock,
  LogOut,
  MessageSquareWarning,
  Monitor,
  Moon,
  Newspaper,
  Palette,
  RefreshCw,
  Repeat,
  Share2,
  ShieldCheck,
  Store,
  Sun,
  Tag,
  Trash2,
  User,
  Wallet,
} from 'lucide-react';
import { openReportProblem } from '../lib/reportProblem';
import { HouseholdMembership } from '../services/householdRepository';
import {
  CurrencyCode,
  Household,
  HouseholdMember,
  LanguageCode,
  Purchase,
  SupermarketStore,
  SupermarketType,
  UserRole,
} from '../types/grocery';
import { exportPurchasesToCsv } from '../utils/exportCsv';
import { formatCurrency } from '../utils/formatters';
import { getTodayIso } from '../utils/dates';
import { Avatar } from './Avatar';
import { InstallAppSettings, NotificationSettings } from './DeviceSettings';
import { SummarySettings } from './SummarySettings';
import { Button, Field, FormSection, MoneyInput, Segmented, SelectInput, Stepper, TextInput } from './ui/Form';
import type { ThemePref } from '../App';

export type SettingsSectionId =
  | 'cuenta'
  | 'hogar'
  | 'presupuesto'
  | 'apariencia'
  | 'notificaciones'
  | 'reposicion'
  | 'precios'
  | 'resumenes'
  | 'facturas'
  | 'datos'
  | 'ayuda';

type SettingsPatch = Partial<
  Pick<Household, 'monthlyBudget' | 'restockLookbackMonths' | 'restockAlertDays' | 'minPurchasesForPrediction' | 'priceAlertThreshold'>
>;

interface SettingsViewProps {
  mode: 'demo' | 'cloud';
  household: Household;
  householdId: string;
  member: HouseholdMember;
  isAdmin: boolean;
  memberships: HouseholdMembership[];
  purchases: Purchase[];
  themePref: ThemePref;
  syncBadge: React.ReactNode;
  defaultPriceAlertThreshold: number;
  section: SettingsSectionId | null;
  onSectionChange: (s: SettingsSectionId | null) => void;
  onSetThemePref: (t: ThemePref) => void;
  onChangeCurrency: (c: CurrencyCode) => void;
  onChangeLanguage: (l: LanguageCode) => void;
  onUpdateSettings: (patch: SettingsPatch) => void;
  onUpdateMemberRole: (memberId: string, role: UserRole) => void;
  onCreateSupermarket: (store: Omit<SupermarketStore, 'id'>) => void;
  onDeleteSupermarket: (id: string) => void;
  onSwitchHousehold: (id: string) => void;
  onSwitchDemoMember?: () => void;
  onResetDemoData: () => void;
  onSignOut: () => void;
  onExitDemo: () => void;
  onOpenEmailInvoices?: () => void;
  onGoToHousehold: () => void;
  sb: SupabaseClient | null;
  userId?: string;
  onToast: (text: string, kind?: 'error' | 'success') => void;
}

const SECTIONS: { id: SettingsSectionId; label: string; desc: string; icon: typeof User }[] = [
  { id: 'cuenta', label: 'Cuenta', desc: 'Perfil, hogares y sesión', icon: User },
  { id: 'hogar', label: 'Hogar y miembros', desc: 'Invitaciones y roles', icon: Home },
  { id: 'presupuesto', label: 'Presupuesto', desc: 'Monto mensual del hogar', icon: Wallet },
  { id: 'apariencia', label: 'Apariencia e idioma', desc: 'Tema, idioma y moneda', icon: Palette },
  { id: 'notificaciones', label: 'Notificaciones', desc: 'Avisos en este dispositivo', icon: Bell },
  { id: 'reposicion', label: 'Reposición', desc: 'Cuándo avisar que algo se acaba', icon: RefreshCw },
  { id: 'precios', label: 'Precios y súpers', desc: 'Alertas y comercios', icon: Tag },
  { id: 'resumenes', label: 'Resúmenes', desc: 'Semanal o mensual', icon: Newspaper },
  { id: 'facturas', label: 'Facturas por correo', desc: 'Tu dirección para facturas', icon: Inbox },
  { id: 'datos', label: 'Datos y dispositivo', desc: 'Exportar, instalar y modo prueba', icon: ShieldCheck },
  { id: 'ayuda', label: 'Ayuda', desc: 'Reportar un problema', icon: LifeBuoy },
];

const STORE_TYPES: SupermarketType[] = [
  'Cadena Nacional',
  'Club Mayorista',
  'Abastecedor / Pulpería',
  'Feria del Agricultor',
  'Carnicería / Especialidad',
  'Otro',
];

/** Card that groups rows/fields inside a section. */
const Panel: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`card p-4 sm:p-5 ${className}`}>{children}</div>
);

const AdminNote: React.FC = () => (
  <p className="flex items-center gap-2 text-sm text-[var(--text-muted)] rounded-xl bg-[var(--glass-bg-subtle)] px-3 py-2.5">
    <Lock className="w-4 h-4 shrink-0" /> Solo un administrador del hogar puede cambiar esto.
  </p>
);

/** Settings, organized by section: list → detail on phones, two columns on desktop. */
export const SettingsView: React.FC<SettingsViewProps> = (props) => {
  const { section, onSectionChange, mode, household } = props;
  const isCloud = mode === 'cloud';
  const visible = SECTIONS;
  const active = section ?? null;
  // Desktop always shows a section; phones show the list until one is chosen
  const desktopActive = active ?? 'cuenta';

  return (
    <div className="lg:grid lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)] lg:gap-8 lg:items-start">
      <nav aria-label="Secciones de ajustes" className={`${active ? 'hidden lg:block' : ''} lg:sticky lg:top-0`}>
        <div className="card p-4 mb-3 flex items-center gap-3 lg:hidden">
          <Avatar
            name={props.member.name}
            src={props.member.avatarUrl}
            color={props.member.accentColor}
            className="w-12 h-12"
          />
          <div className="min-w-0 flex-1">
            <p className="font-bold truncate">{props.member.name}</p>
            <p className="text-sm text-[var(--text-muted)] truncate">
              {household.name} · {props.member.role === 'admin' ? 'Admin' : 'Miembro'}
            </p>
          </div>
        </div>
        <ul className="card p-1.5 space-y-0.5">
          {visible.map((s) => {
            const Icon = s.icon;
            const isActive = desktopActive === s.id;
            return (
              <li key={s.id}>
                <button
                  onClick={() => onSectionChange(s.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`w-full flex items-center gap-3 px-3 py-3 lg:py-2.5 rounded-xl text-left transition ${
                    isActive
                      ? 'lg:bg-avocado-100 lg:dark:bg-avocado-500/15'
                      : 'hover:bg-[var(--glass-bg-hover)]'
                  }`}
                >
                  <span className="w-9 h-9 lg:w-8 lg:h-8 rounded-xl bg-avocado-50 dark:bg-avocado-500/10 text-avocado-700 dark:text-avocado-300 flex items-center justify-center shrink-0">
                    <Icon className="w-[18px] h-[18px]" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[15px] lg:text-sm font-semibold">{s.label}</span>
                    <span className="block text-xs text-[var(--text-muted)] truncate lg:hidden">{s.desc}</span>
                  </span>
                  <ChevronRight className="w-4 h-4 text-[var(--text-muted)] lg:hidden" />
                </button>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-[var(--text-muted)] text-center mt-4 lg:text-left lg:px-2">
          Canastica · {isCloud ? 'Cuenta conectada' : 'Modo prueba'}
        </p>
      </nav>

      <div className={`${active ? '' : 'hidden lg:block'} min-w-0`}>
        <button
          onClick={() => onSectionChange(null)}
          className="lg:hidden -ml-1 mb-3 inline-flex items-center gap-1 min-h-10 pr-3 text-sm font-semibold text-avocado-700 dark:text-avocado-300"
        >
          <ChevronLeft className="w-5 h-5" /> Ajustes
        </button>
        <SectionBody {...props} sectionId={desktopActive} />
      </div>
    </div>
  );
};

const SectionHeader: React.FC<{ id: SettingsSectionId }> = ({ id }) => {
  const meta = SECTIONS.find((s) => s.id === id)!;
  return (
    <header className="mb-4">
      <h2 className="text-xl font-bold tracking-tight">{meta.label}</h2>
      <p className="text-sm text-[var(--text-muted)]">{meta.desc}</p>
    </header>
  );
};

const SectionBody: React.FC<SettingsViewProps & { sectionId: SettingsSectionId }> = (props) => {
  const { sectionId } = props;
  return (
    <div className="max-w-3xl">
      <SectionHeader id={sectionId} />
      <div className="space-y-4">
        {sectionId === 'cuenta' && <AccountSection {...props} />}
        {sectionId === 'hogar' && <HouseholdSection {...props} />}
        {sectionId === 'presupuesto' && <BudgetSection {...props} />}
        {sectionId === 'apariencia' && <AppearanceSection {...props} />}
        {sectionId === 'notificaciones' && (
          <Panel>
            <NotificationSettings sb={props.mode === 'cloud' ? props.sb : null} userId={props.userId} onToast={props.onToast} />
          </Panel>
        )}
        {sectionId === 'reposicion' && <RestockSection {...props} />}
        {sectionId === 'precios' && <PricesSection {...props} />}
        {sectionId === 'resumenes' && (
          <Panel>
            {props.mode === 'cloud' && props.sb && props.userId ? (
              <SummarySettings sb={props.sb} userId={props.userId} householdId={props.householdId} onToast={props.onToast} />
            ) : (
              <p className="text-sm text-[var(--text-muted)]">Los resúmenes por correo y notificación requieren iniciar sesión.</p>
            )}
          </Panel>
        )}
        {sectionId === 'facturas' && (
          <Panel className="space-y-3">
            <p className="text-sm text-[var(--text-secondary)]">
              Recibe una dirección de correo propia del hogar. Las facturas electrónicas que lleguen ahí se registran solas o
              quedan listas para revisar.
            </p>
            {props.onOpenEmailInvoices ? (
              <Button onClick={props.onOpenEmailInvoices}>
                <Inbox className="w-4 h-4" /> Configurar facturas por correo
              </Button>
            ) : (
              <p className="text-sm text-[var(--text-muted)]">
                {props.mode === 'cloud'
                  ? 'Esta función todavía no está activada en este ambiente.'
                  : 'Disponible al iniciar sesión con tu cuenta.'}
              </p>
            )}
          </Panel>
        )}
        {sectionId === 'datos' && <DataSection {...props} />}
        {sectionId === 'ayuda' && (
          <Panel className="space-y-3">
            {props.mode === 'cloud' ? (
              <Button variant="soft" onClick={() => openReportProblem()}>
                <MessageSquareWarning className="w-4 h-4" /> Reportar un problema
              </Button>
            ) : (
              <p className="text-sm text-[var(--text-muted)]">Para reportar un problema inicia sesión con tu cuenta.</p>
            )}
            <p className="text-sm text-[var(--text-secondary)]">
              Para agregar productos desde otra app, usa <strong>Compartir → Canastica</strong> (con la app instalada) o el
              botón <strong>Pegar lista</strong> en la lista de compras.
            </p>
          </Panel>
        )}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */

const AccountSection: React.FC<SettingsViewProps> = ({
  mode,
  member,
  household,
  householdId,
  memberships,
  syncBadge,
  onSwitchHousehold,
  onSwitchDemoMember,
  onResetDemoData,
  onSignOut,
  onExitDemo,
}) => (
  <>
    <Panel className="flex items-center gap-4">
      <Avatar name={member.name} src={member.avatarUrl} color={member.accentColor} className="w-14 h-14" />
      <div className="min-w-0 flex-1">
        <p className="text-lg font-bold truncate">{member.name}</p>
        <p className="text-sm text-[var(--text-muted)] truncate">{member.email || 'Sin correo'}</p>
        <p className="text-xs font-semibold text-avocado-700 dark:text-avocado-300 mt-0.5">
          {member.role === 'admin' ? 'Administrador' : 'Miembro'} de {household.name}
        </p>
      </div>
      <span className="hidden sm:inline-flex">{syncBadge}</span>
    </Panel>

    {mode === 'cloud' && memberships.length > 1 && (
      <Panel>
        <FormSection title="Tus hogares" description="Cambia el hogar que estás viendo.">
          <ul className="divide-y divide-[var(--glass-border)]">
            {memberships.map((m) => (
              <li key={m.householdId}>
                <button
                  onClick={() => onSwitchHousehold(m.householdId)}
                  className="w-full min-h-12 flex items-center justify-between text-[15px] font-medium text-left"
                >
                  <span className="truncate">{m.householdName}</span>
                  {m.householdId === householdId ? (
                    <Check className="w-5 h-5 text-avocado-600" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </FormSection>
      </Panel>
    )}

    <Panel className="flex flex-col sm:flex-row gap-2">
      {mode === 'demo' ? (
        <>
          {onSwitchDemoMember && (
            <Button variant="secondary" onClick={onSwitchDemoMember}>
              <Repeat className="w-4 h-4" /> Ver como otro miembro
            </Button>
          )}
          <Button variant="secondary" onClick={onResetDemoData}>
            <RefreshCw className="w-4 h-4" /> Restablecer datos de ejemplo
          </Button>
          <Button onClick={onExitDemo}>
            <LogOut className="w-4 h-4" /> Salir del modo prueba
          </Button>
        </>
      ) : (
        <Button variant="danger" onClick={onSignOut}>
          <LogOut className="w-4 h-4" /> Cerrar sesión
        </Button>
      )}
    </Panel>
  </>
);

const HouseholdSection: React.FC<SettingsViewProps> = ({ household, isAdmin, mode, member, onUpdateMemberRole, onGoToHousehold, onToast }) => {
  const [copied, setCopied] = useState(false);
  const inviteUrl = `${window.location.origin}${window.location.pathname}?join=${encodeURIComponent(household.inviteCode)}`;
  const canEdit = isAdmin || mode === 'demo';

  const share = async () => {
    const text = `Únete a nuestro hogar "${household.name}" en Canastica: ${inviteUrl} (código ${household.inviteCode})`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Canastica', text, url: inviteUrl });
        return;
      } catch {
        // cancelled: fall back to copying
      }
    }
    try {
      await navigator.clipboard?.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onToast('No se pudo copiar. Comparte el código que ves en pantalla.');
    }
  };

  return (
    <>
      <Panel className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-[var(--text-muted)]">Hogar</p>
            <p className="text-lg font-bold truncate">{household.name}</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-[var(--text-muted)]">Código</p>
            <p className="text-lg font-bold tracking-widest text-avocado-700 dark:text-avocado-300 select-all">
              {household.inviteCode}
            </p>
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-2">
          <Button onClick={() => void share()}>
            <Share2 className="w-4 h-4" /> Invitar a alguien
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              navigator.clipboard
                ?.writeText(household.inviteCode)
                .then(() => onToast('Código copiado', 'success'))
                .catch(() => onToast('No se pudo copiar el código.'))
            }
          >
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} Copiar código
          </Button>
        </div>
      </Panel>

      <Panel>
        <FormSection
          title={`Miembros (${household.members.length})`}
          description="Los administradores cambian presupuesto, reposición y roles."
        >
          <ul className="divide-y divide-[var(--glass-border)]">
            {household.members.map((m) => (
              <li key={m.id} className="py-3 flex flex-wrap items-center gap-3">
                <Avatar name={m.name} src={m.avatarUrl} color={m.accentColor} className="w-10 h-10" />
                <div className="flex-1 min-w-[120px]">
                  <p className="font-semibold truncate">
                    {m.name}
                    {m.id === member.id && <span className="text-[var(--text-muted)] font-normal"> (tú)</span>}
                  </p>
                  <p className="text-xs text-[var(--text-muted)] truncate">{m.email || 'Sin correo'}</p>
                </div>
                <div className="w-full sm:w-56">
                  <Segmented
                    aria-label={`Rol de ${m.name}`}
                    value={m.role}
                    disabled={!canEdit}
                    onChange={(role) => onUpdateMemberRole(m.id, role)}
                    options={[
                      { value: 'admin', label: 'Admin' },
                      { value: 'member', label: 'Miembro' },
                    ]}
                  />
                </div>
              </li>
            ))}
          </ul>
        </FormSection>
      </Panel>
      <Button variant="ghost" onClick={onGoToHousehold}>
        Ver saldos y actividad del hogar <ChevronRight className="w-4 h-4" />
      </Button>
    </>
  );
};

const BudgetSection: React.FC<SettingsViewProps> = ({ household, isAdmin, mode, onUpdateSettings, onToast }) => {
  const [budget, setBudget] = useState(household.monthlyBudget);
  const canEdit = isAdmin || mode === 'demo';
  const dirty = budget !== household.monthlyBudget;
  return (
    <Panel className="space-y-4">
      {!canEdit && <AdminNote />}
      <Field
        label="Presupuesto mensual del hogar"
        hint={`Se guarda en colones. Actual: ${formatCurrency(household.monthlyBudget, 'CRC')}`}
      >
        {(id) => (
          <MoneyInput
            id={id}
            symbol="₡"
            value={budget}
            disabled={!canEdit}
            step={1000}
            onValueChange={setBudget}
            enterKeyHint="done"
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        {[200000, 320000, 450000, 600000].map((v) => (
          <button
            key={v}
            type="button"
            disabled={!canEdit}
            onClick={() => setBudget(v)}
            className={`min-h-10 px-3.5 rounded-full border text-sm font-semibold transition disabled:opacity-50 ${
              budget === v
                ? 'bg-avocado-600 border-avocado-600 text-white'
                : 'border-[var(--input-border)] text-[var(--text-secondary)] hover:border-avocado-400'
            }`}
          >
            {formatCurrency(v, 'CRC', true)}
          </button>
        ))}
      </div>
      <div className="flex justify-end">
        <Button
          disabled={!canEdit || !dirty || budget <= 0}
          onClick={() => {
            onUpdateSettings({ monthlyBudget: Math.round(budget) });
            onToast('Presupuesto actualizado', 'success');
          }}
        >
          Guardar presupuesto
        </Button>
      </div>
    </Panel>
  );
};

const AppearanceSection: React.FC<SettingsViewProps> = ({ themePref, household, onSetThemePref, onChangeCurrency, onChangeLanguage }) => (
  <Panel className="space-y-5">
    <Field label="Tema" hint="«Sistema» sigue el modo claro u oscuro de tu dispositivo.">
      {() => (
        <Segmented
          aria-label="Tema"
          value={themePref}
          onChange={onSetThemePref}
          options={[
            { value: 'system', label: <><Monitor className="w-4 h-4" /> Sistema</> },
            { value: 'light', label: <><Sun className="w-4 h-4" /> Claro</> },
            { value: 'dark', label: <><Moon className="w-4 h-4" /> Oscuro</> },
          ]}
        />
      )}
    </Field>
    <Field label="Idioma">
      {() => (
        <Segmented
          aria-label="Idioma"
          value={household.language}
          onChange={onChangeLanguage}
          options={[
            { value: 'es', label: 'Español' },
            { value: 'en', label: 'English' },
          ]}
        />
      )}
    </Field>
    <Field label="Moneda" hint="Solo cambia cómo se muestran los montos en este dispositivo.">
      {() => (
        <Segmented
          aria-label="Moneda"
          value={household.currency}
          onChange={onChangeCurrency}
          options={[
            { value: 'CRC', label: '₡ Colones' },
            { value: 'USD', label: '$ Dólares' },
          ]}
        />
      )}
    </Field>
  </Panel>
);

const RestockSection: React.FC<SettingsViewProps> = ({ household, isAdmin, mode, onUpdateSettings, onToast }) => {
  const canEdit = isAdmin || mode === 'demo';
  const [lookback, setLookback] = useState(household.restockLookbackMonths);
  const [alertDays, setAlertDays] = useState(household.restockAlertDays);
  const [minPurchases, setMinPurchases] = useState(household.minPurchasesForPrediction);
  const dirty =
    lookback !== household.restockLookbackMonths ||
    alertDays !== household.restockAlertDays ||
    minPurchases !== household.minPurchasesForPrediction;
  return (
    <Panel className="space-y-5">
      {!canEdit && <AdminNote />}
      <Field label="Historial que se analiza" hint="Más meses = predicción más estable; menos meses = reacciona más rápido.">
        {() => (
          <Segmented
            aria-label="Meses de historial"
            value={String(lookback) as '3' | '6' | '12'}
            disabled={!canEdit}
            onChange={(v) => setLookback(Number(v) as 3 | 6 | 12)}
            options={[
              { value: '3', label: '3 meses' },
              { value: '6', label: '6 meses' },
              { value: '12', label: '12 meses' },
            ]}
          />
        )}
      </Field>
      <div className="grid sm:grid-cols-2 gap-5">
        <Field label="Avisar con anticipación" hint="Días antes de que se acabe un producto.">
          {() => <Stepper label="días de anticipación" value={alertDays} min={1} max={30} onChange={setAlertDays} />}
        </Field>
        <Field label="Compras mínimas para predecir" hint="Cuántas veces debes haber comprado algo.">
          {() => <Stepper label="compras mínimas" value={minPurchases} min={2} max={10} onChange={setMinPurchases} />}
        </Field>
      </div>
      <div className="flex justify-end">
        <Button
          disabled={!canEdit || !dirty}
          onClick={() => {
            onUpdateSettings({ restockLookbackMonths: lookback, restockAlertDays: alertDays, minPurchasesForPrediction: minPurchases });
            onToast('Ajustes de reposición guardados', 'success');
          }}
        >
          Guardar cambios
        </Button>
      </div>
    </Panel>
  );
};

const PricesSection: React.FC<SettingsViewProps> = ({
  household,
  isAdmin,
  mode,
  defaultPriceAlertThreshold,
  onUpdateSettings,
  onCreateSupermarket,
  onDeleteSupermarket,
  onToast,
}) => {
  const canEdit = isAdmin || mode === 'demo';
  const current = household.priceAlertThreshold ?? defaultPriceAlertThreshold;
  const [threshold, setThreshold] = useState(current);
  const [name, setName] = useState('');
  const [type, setType] = useState<SupermarketType>('Cadena Nacional');
  const [location, setLocation] = useState('');
  const exists = useMemo(
    () => household.supermarkets.some((s) => s.name.trim().toLowerCase() === name.trim().toLowerCase()),
    [household.supermarkets, name]
  );

  return (
    <>
      <Panel className="space-y-4">
        {!canEdit && <AdminNote />}
        <Field label="Avisar cuando un producto suba" hint="Comparado con lo que pagaste la última vez.">
          {() => (
            <div className="flex items-center gap-3">
              <div className="w-44">
                <Stepper label="porcentaje" value={threshold} min={1} max={50} onChange={setThreshold} />
              </div>
              <span className="text-[15px] font-semibold">% o más</span>
            </div>
          )}
        </Field>
        <div className="flex justify-end">
          <Button
            disabled={!canEdit || threshold === current}
            onClick={() => {
              onUpdateSettings({ priceAlertThreshold: threshold });
              onToast('Umbral de alertas guardado', 'success');
            }}
          >
            Guardar umbral
          </Button>
        </div>
      </Panel>

      <Panel>
        <FormSection title="Comercios" description="Aparecen al registrar compras y en el comparador de precios.">
          <ul className="divide-y divide-[var(--glass-border)]">
            {household.supermarkets.map((s) => (
              <li key={s.id} className="py-2.5 flex items-center gap-3">
                <span className="w-3 h-3 rounded-full shrink-0" style={{ background: s.color }} />
                <span className="flex-1 min-w-0">
                  <span className="block text-[15px] font-medium truncate">{s.name}</span>
                  <span className="block text-xs text-[var(--text-muted)] truncate">
                    {s.type}
                    {s.locationHint ? ` · ${s.locationHint}` : ''}
                  </span>
                </span>
                {s.isCustom && (
                  <button
                    onClick={() => onDeleteSupermarket(s.id)}
                    className="w-10 h-10 rounded-full flex items-center justify-center text-[var(--text-muted)] hover:text-coral-500 hover:bg-coral-500/10"
                    aria-label={`Eliminar ${s.name}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <form
            className="pt-4 mt-1 border-t border-[var(--glass-border)] space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || exists) return;
              onCreateSupermarket({
                name: name.trim(),
                type,
                color: '#74a03a',
                locationHint: location.trim() || undefined,
                isCustom: true,
              });
              onToast(`${name.trim()} agregado`, 'success');
              setName('');
              setLocation('');
            }}
          >
            <p className="text-sm font-bold flex items-center gap-2">
              <Store className="w-4 h-4 text-avocado-600" /> Agregar comercio
            </p>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Nombre" error={exists ? 'Ya existe un comercio con ese nombre.' : undefined}>
                {(id) => (
                  <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Pulpería La Amistad" autoComplete="off" />
                )}
              </Field>
              <Field label="Tipo">
                {(id) => (
                  <SelectInput id={id} value={type} onChange={(e) => setType(e.target.value as SupermarketType)}>
                    {STORE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </SelectInput>
                )}
              </Field>
              <Field label="Zona (opcional)" className="sm:col-span-2">
                {(id) => <TextInput id={id} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Ej. Curridabat" />}
              </Field>
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="soft" disabled={!name.trim() || exists}>
                Agregar comercio
              </Button>
            </div>
          </form>
        </FormSection>
      </Panel>
    </>
  );
};

const DataSection: React.FC<SettingsViewProps> = ({ purchases, household, mode, onResetDemoData, onToast }) => {
  const today = getTodayIso();
  const [from, setFrom] = useState(() => `${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  return (
    <>
      <Panel>
        <FormSection title="Exportar compras" description="Descarga un CSV que abre en Excel o Google Sheets.">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Desde">{(id) => <TextInput id={id} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label="Hasta">{(id) => <TextInput id={id} type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />}</Field>
          </div>
          <Button
            variant="soft"
            onClick={() => {
              const n = exportPurchasesToCsv(purchases, household.members, from, to);
              onToast(n > 0 ? `Exportamos ${n} ${n === 1 ? 'compra' : 'compras'}` : 'No hay compras en ese rango', n > 0 ? 'success' : 'error');
            }}
          >
            <Download className="w-4 h-4" /> Exportar CSV
          </Button>
        </FormSection>
      </Panel>
      <Panel>
        <FormSection title="Instalar en este dispositivo" description="Abre más rápido y funciona sin conexión.">
          <InstallAppSettings />
        </FormSection>
      </Panel>
      {mode === 'demo' && (
        <Panel>
          <FormSection title="Modo prueba" description="Los datos de ejemplo solo viven en este navegador.">
            <Button variant="danger" onClick={onResetDemoData}>
              <RefreshCw className="w-4 h-4" /> Restablecer datos de ejemplo
            </Button>
          </FormSection>
        </Panel>
      )}
    </>
  );
};

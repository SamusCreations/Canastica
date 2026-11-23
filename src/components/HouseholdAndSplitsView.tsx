import React, { useState } from 'react';
import {
  ArrowRight,
  History,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crown,
  Plus,
  ShieldCheck,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import { Button, Field, TextInput } from './ui/Form';
import {
  ExpenseSettlement,
  Household,
  Purchase,
  SupermarketStore,
  UserRole,
} from '../types/grocery';
import { formatCurrency } from '../utils/formatters';
import { getCurrentMonthPrefix } from '../utils/dates';
import { Avatar } from './Avatar';
import { HouseholdActivityView } from './HouseholdActivityView';
import type { HouseholdActivityEntry } from '../services/householdRepository';
import { SettleSheet, type SettleDetails } from './SettleSheet';
import { AssigneeSelect } from './AssigneeSelect';

interface HouseholdAndSplitsViewProps {
  mode?: 'demo' | 'cloud';
  household: Household;
  currentMemberId: string;
  purchases: Purchase[];
  settlements: ExpenseSettlement[];
  onSwitchCurrentMember: (memberId: string) => void;
  onUpdateMemberRole: (memberId: string, role: UserRole) => void;
  onAddMember: (name: string, email: string) => void;
  onJoinHousehold?: (inviteCode: string) => Promise<string | null>;
  onCreateSupermarket: (store: Omit<SupermarketStore, 'id'>) => void;
  onOpenSettings?: () => void;
  /** 'shared' or the id of the member the item belongs to */
  onAssignItem: (purchaseId: string, itemId: string, assignee: string) => void;
  onRecordSettlement: (fromMemberId: string, toMemberId: string, amount: number, details: SettleDetails) => void;
  loadActivity?: (() => Promise<HouseholdActivityEntry[]>) | null;
}

export const HouseholdAndSplitsView: React.FC<HouseholdAndSplitsViewProps> = ({
  mode = 'demo',
  household,
  currentMemberId,
  purchases,
  settlements,
  onSwitchCurrentMember,
  onUpdateMemberRole,
  onAddMember,
  onJoinHousehold,
  onOpenSettings,
  onAssignItem,
  onRecordSettlement,
  loadActivity = null,
}) => {
  const [subTab, setSubTab] = useState<'splits' | 'settings' | 'activity'>('splits');
  const [itemPage, setItemPage] = useState(0);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [joinStatusMsg, setJoinStatusMsg] = useState<string | null>(null);

  // Quick custom supermarket creator

  const cur = household.currency;
  const currentMember =
    household.members.find((m) => m.id === currentMemberId) || household.members[0];
  const isAdmin = currentMember.role === 'admin';

  const octPurchases = purchases.filter((p) => p.purchaseDate.startsWith(getCurrentMonthPrefix()));
  const memberCount = Math.max(1, household.members.length);

  let totalSharedPool = 0;
  const paidByMember = new Map<string, number>();
  const personalByMember = new Map<string, number>();

  for (const m of household.members) {
    paidByMember.set(m.id, 0);
    personalByMember.set(m.id, 0);
  }

  for (const purchase of octPurchases) {
    paidByMember.set(
      purchase.createdBy,
      (paidByMember.get(purchase.createdBy) || 0) + purchase.totalAmount
    );

    const itemsSum = purchase.items.reduce((s, i) => s + i.totalPrice, 0);
    const scaleFactor = itemsSum > 0 ? purchase.totalAmount / itemsSum : 1;

    for (const item of purchase.items) {
      const effectiveCost = item.totalPrice * scaleFactor;
      if (item.isShared) {
        totalSharedPool += effectiveCost;
      } else {
        const owner =
          item.assignedTo && personalByMember.has(item.assignedTo) ? item.assignedTo : purchase.createdBy;
        personalByMember.set(owner, (personalByMember.get(owner) || 0) + effectiveCost);
      }
    }
  }

  const equalSharedSharePerMember = totalSharedPool / memberCount;

  const netBalanceByMember = new Map<string, number>();
  for (const m of household.members) {
    const totalPaid = paidByMember.get(m.id) || 0;
    const personalResponsibility = personalByMember.get(m.id) || 0;
    const totalResponsibility = equalSharedSharePerMember + personalResponsibility;
    let net = totalPaid - totalResponsibility;

    for (const s of settlements) {
      if (s.fromMemberId === m.id) net += s.amount;
      if (s.toMemberId === m.id) net -= s.amount;
    }
    netBalanceByMember.set(m.id, Math.round(net));
  }

  const debtors = household.members
    .map((m) => ({ member: m, balance: netBalanceByMember.get(m.id) || 0 }))
    .filter((x) => x.balance < -100)
    .sort((a, b) => a.balance - b.balance);

  const creditors = household.members
    .map((m) => ({ member: m, balance: netBalanceByMember.get(m.id) || 0 }))
    .filter((x) => x.balance > 100)
    .sort((a, b) => b.balance - a.balance);

  const suggestedTransfers: {
    fromId: string;
    fromName: string;
    toId: string;
    toName: string;
    amount: number;
  }[] = [];

  const [settling, setSettling] = useState<(typeof suggestedTransfers)[number] | null>(null);

  const dCopy = debtors.map((d) => ({ ...d, rem: Math.abs(d.balance) }));
  const cCopy = creditors.map((c) => ({ ...c, rem: c.balance }));

  let dIdx = 0;
  let cIdx = 0;
  while (dIdx < dCopy.length && cIdx < cCopy.length) {
    const payAmt = Math.min(dCopy[dIdx].rem, cCopy[cIdx].rem);
    if (payAmt > 100) {
      suggestedTransfers.push({
        fromId: dCopy[dIdx].member.id,
        fromName: dCopy[dIdx].member.name,
        toId: cCopy[cIdx].member.id,
        toName: cCopy[cIdx].member.name,
        amount: Math.round(payAmt),
      });
    }
    dCopy[dIdx].rem -= payAmt;
    cCopy[cIdx].rem -= payAmt;
    if (dCopy[dIdx].rem <= 100) dIdx++;
    if (cCopy[cIdx].rem <= 100) cIdx++;
  }

  // Flatten October items for paginated Shared vs Personal classification (no scrollbar!)
  const allOctItems = octPurchases.flatMap((p) =>
    p.items.map((item) => ({
      purchaseId: p.id,
      supermarket: p.supermarket,
      buyerId: p.createdBy,
      item,
    }))
  );
  const itemsPerPage = 5;
  const totalPages = Math.max(1, Math.ceil(allOctItems.length / itemsPerPage));
  const paginatedItems = allOctItems.slice(
    itemPage * itemsPerPage,
    (itemPage + 1) * itemsPerPage
  );

  const isCloud = mode === 'cloud';
  const inviteUrl = `${window.location.origin}${window.location.pathname}?join=${encodeURIComponent(
    household.inviteCode
  )}`;

  const handleCopyInvite = async () => {
    const text = `Únete a nuestro hogar "${household.name}" en Canastica: ${inviteUrl} (código ${household.inviteCode})`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Canastica', text, url: inviteUrl });
        return;
      } catch {
        // user cancelled the share sheet; fall back to copying
      }
    }
    try {
      await navigator.clipboard?.writeText(inviteUrl);
    } catch {
      // clipboard blocked; the code is still visible on screen
    }
    setCopiedInvite(true);
    setTimeout(() => setCopiedInvite(false), 2000);
  };

  const [joinBusy, setJoinBusy] = useState(false);
  const handleJoin = async () => {
    const code = joinCodeInput.trim();
    if (!code) return;
    if (!onJoinHousehold || !isCloud) {
      setJoinStatusMsg(`¡Conectado al hogar ${code}!`);
      setJoinCodeInput('');
      setTimeout(() => setJoinStatusMsg(null), 3000);
      return;
    }
    setJoinBusy(true);
    const err = await onJoinHousehold(code);
    setJoinBusy(false);
    setJoinStatusMsg(err ?? '¡Listo! Ya eres parte del hogar.');
    if (!err) setJoinCodeInput('');
    setTimeout(() => setJoinStatusMsg(null), 4000);
  };

  return (
    <div className="space-y-3.5">
      {/* Top Minimalist Segmented Navigation & Invite Code Bar */}
      <div className="liquid-glass rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <div className="liquid-glass-subtle rounded-lg p-1 grid grid-cols-3 gap-1 w-full sm:w-auto">
          <button
            onClick={() => setSubTab('splits')}
            className={`min-h-[40px] px-3 py-1.5 rounded-md text-sm font-bold flex items-center justify-center gap-1.5 transition ${
              subTab === 'splits'
                ? 'liquid-lens-btn text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Wallet className="w-3.5 h-3.5 shrink-0" />
            <span className="sm:hidden">Saldos</span>
            <span className="hidden sm:inline">División de Gastos y Saldos</span>
          </button>
          <button
            onClick={() => setSubTab('settings')}
            className={`min-h-[40px] px-3 py-1.5 rounded-md text-sm font-bold flex items-center justify-center gap-1.5 transition ${
              subTab === 'settings'
                ? 'liquid-lens-btn text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Users className="w-3.5 h-3.5 shrink-0" />
            <span className="sm:hidden">Miembros ({household.members.length})</span>
            <span className="hidden sm:inline">Miembros, Presupuesto y Comercios ({household.members.length})</span>
          </button>
          <button
            onClick={() => setSubTab('activity')}
            className={`min-h-[40px] px-3 py-1.5 rounded-md text-sm font-bold flex items-center justify-center gap-1.5 transition ${
              subTab === 'activity'
                ? 'liquid-lens-btn text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <History className="w-3.5 h-3.5 shrink-0" />
            Historial
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-muted)] hidden sm:inline">
            Cuota compartida: <strong>{formatCurrency(equalSharedSharePerMember, cur)}</strong>/miembro
          </span>
          <button
            onClick={() => void handleCopyInvite()}
            className="liquid-glass-subtle liquid-glass-interactive px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 text-avocado-600 dark:text-avocado-400"
          >
            <span>Código: {household.inviteCode}</span>
            {copiedInvite ? (
              <Check className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* ====================================================================
          SUB-VIEW 1: División de Gastos y Saldos (Zero Scrollbars!)
          ==================================================================== */}
      {subTab === 'splits' && (
        <div className="space-y-3.5 animate-spring-in">
          {/* 4 Member Balance Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
            {household.members.map((member) => {
              const paid = paidByMember.get(member.id) || 0;
              const personal = personalByMember.get(member.id) || 0;
              const net = netBalanceByMember.get(member.id) || 0;

              return (
                <div
                  key={member.id}
                  className="liquid-glass rounded-xl p-3.5 flex flex-col justify-between gap-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Avatar name={member.name} src={member.avatarUrl} color={member.accentColor} className="w-9 h-9" />
                      <div className="min-w-0">
                        <h3 className="text-xs font-bold truncate">{member.name}</h3>
                        <span className="text-[10px] font-semibold text-[var(--text-muted)] block">
                          {member.role === 'admin' ? 'Administrador' : 'Miembro'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1 text-[11px] pt-2 border-t border-[var(--glass-border)]">
                    <div className="flex justify-between text-[var(--text-secondary)]">
                      <span>Pagó en caja:</span>
                      <span className="font-mono font-bold">{formatCurrency(paid, cur)}</span>
                    </div>
                    <div className="flex justify-between text-[var(--text-muted)]">
                      <span>Cuota compartida:</span>
                      <span className="font-mono">
                        {formatCurrency(equalSharedSharePerMember, cur)}
                      </span>
                    </div>
                    <div className="flex justify-between text-[var(--text-muted)]">
                      <span>Ítems personales:</span>
                      <span className="font-mono text-purple-600 dark:text-purple-400">
                        {formatCurrency(personal, cur)}
                      </span>
                    </div>
                  </div>

                  <div
                    className={`rounded-lg py-1.5 px-2 text-center font-mono text-xs font-extrabold ${
                      net > 100
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : net < -100
                        ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                        : 'bg-slate-500/10 text-[var(--text-muted)]'
                    }`}
                  >
                    {net > 100
                      ? `A favor +${formatCurrency(net, cur)}`
                      : net < -100
                      ? `Debe −${formatCurrency(Math.abs(net), cur)}`
                      : 'Al día (₡0)'}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Settlements + Paginated Item Classification (No Nested Scrollbar!) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
            <div className="lg:col-span-5 liquid-glass rounded-xl p-4 space-y-3">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-avocado-600 dark:text-avocado-400">
                  Saldos Pendientes (“Quién le debe a quién”)
                </h3>
                <p className="hidden sm:block text-[11px] text-[var(--text-muted)] mt-0.5">
                  Transferencias óptimas sugeridas para saldar el mes
                </p>
              </div>

              {suggestedTransfers.length === 0 ? (
                <div className="p-3 rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs flex items-center gap-2 font-semibold">
                  <CheckCircle2 className="w-4 h-4" /> ¡Todos los miembros están al día!
                </div>
              ) : (
                <div className="space-y-2">
                  {suggestedTransfers.map((tr, i) => (
                    <div
                      key={i}
                      className="liquid-glass-subtle rounded-xl p-2.5 flex items-center justify-between gap-2"
                    >
                      <div className="text-xs flex items-center gap-1.5 flex-wrap">
                        <span className="font-bold text-rose-600 dark:text-rose-400">
                          {tr.fromName.split(' ')[0]}
                        </span>
                        <ArrowRight className="w-3 h-3 text-[var(--text-muted)]" />
                        <span className="font-bold text-emerald-600 dark:text-emerald-400">
                          {tr.toName.split(' ')[0]}
                        </span>
                        <span className="font-mono font-extrabold text-xs ml-1">
                          {formatCurrency(tr.amount, cur)}
                        </span>
                      </div>
                      <button
                        onClick={() => setSettling(tr)}
                        className="px-2.5 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-700 dark:text-emerald-300 text-[11px] font-bold transition shrink-0"
                      >
                        Liquidar
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {settling && (
                <SettleSheet
                  fromName={settling.fromName}
                  toName={settling.toName}
                  amount={settling.amount}
                  currency={cur}
                  onCancel={() => setSettling(null)}
                  onConfirm={(details) => {
                    onRecordSettlement(settling.fromId, settling.toId, settling.amount, details);
                    setSettling(null);
                  }}
                />
              )}
            </div>

            {/* Paginated Shared vs Personal Item Classifier */}
            <div className="lg:col-span-7 liquid-glass rounded-xl p-4 flex flex-col justify-between space-y-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider">
                    Clasificar Ítems: Compartido vs. Personal
                  </h3>
                  <p className="hidden sm:block text-[11px] text-[var(--text-muted)]">
                    Haz clic en la etiqueta de cualquier producto para cambiar su división
                  </p>
                </div>

                {/* Clean Pagination Controls */}
                <div className="flex items-center gap-1.5 text-xs">
                  <button
                    onClick={() => setItemPage((p) => Math.max(0, p - 1))}
                    disabled={itemPage === 0}
                    className="p-1 rounded-md liquid-glass-subtle liquid-glass-interactive disabled:opacity-40"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-[11px] font-mono text-[var(--text-muted)]">
                    {itemPage + 1}/{totalPages}
                  </span>
                  <button
                    onClick={() => setItemPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={itemPage >= totalPages - 1}
                    className="p-1 rounded-md liquid-glass-subtle liquid-glass-interactive disabled:opacity-40"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                {paginatedItems.map(({ purchaseId, buyerId, item }) => {
                  const buyer = household.members.find((m) => m.id === buyerId);
                  return (
                    <div
                      key={item.id}
                      className="liquid-glass-subtle rounded-lg px-3 py-1.5 flex items-center justify-between text-xs"
                    >
                      <div className="min-w-0 pr-2 flex items-center gap-2">
                        <span className="font-semibold truncate">{item.normalizedName}</span>
                        <span className="text-[11px] text-[var(--text-muted)] shrink-0">
                          {formatCurrency(item.totalPrice, cur)} • {buyer?.name.split(' ')[0]}
                        </span>
                      </div>
                      <AssigneeSelect
                        members={household.members}
                        isShared={item.isShared}
                        assignedTo={item.assignedTo ?? buyer?.id}
                        onChange={(value) => onAssignItem(purchaseId, item.id, value)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          SUB-VIEW 2: Miembros, Presupuesto y Comercios (Zero Scrollbars!)
          ==================================================================== */}
      {subTab === 'activity' && (
        <HouseholdActivityView members={household.members} loadActivity={loadActivity} />
      )}

      {subTab === 'settings' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 animate-spring-in">
          {/* Left: Members & Active User Switcher (7 cols) */}
          <div className="lg:col-span-7 liquid-glass rounded-xl p-4 flex flex-col justify-between space-y-3">
            <div>
              <h3 className="text-sm font-bold flex items-center gap-2">
                <Users className="w-4 h-4 text-avocado-600 dark:text-avocado-400" />
                Miembros del Hogar y Permisos de Rol
              </h3>
              <p className="text-xs text-[var(--text-muted)]">
                {isCloud
                  ? 'Los administradores pueden cambiar el presupuesto y los roles'
                  : 'Cambia de usuario activo o gestiona los roles de Administrador y Miembro'}
              </p>
            </div>

            <div className="space-y-2">
              {household.members.map((m) => {
                const isCurrent = m.id === currentMemberId;
                return (
                  <div
                    key={m.id}
                    className={`liquid-glass-subtle rounded-xl p-2.5 flex flex-wrap items-center justify-between gap-2 border ${
                      isCurrent
                        ? 'border-avocado-500/50 bg-avocado-500/5'
                        : 'border-[var(--glass-border)]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Avatar name={m.name} src={m.avatarUrl} color={m.accentColor} className="w-8 h-8" />
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-bold">{m.name}</span>
                          {isCurrent && (
                            <span className="text-[9px] font-bold uppercase px-1.5 py-0.2 rounded-full bg-avocado-500/15 text-avocado-600 dark:text-avocado-400">
                              Activo
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-[var(--text-muted)]">{m.email}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {isAdmin ? (
                        <select
                          value={m.role}
                          onChange={(e) =>
                            onUpdateMemberRole(m.id, e.target.value as UserRole)
                          }
                          className="liquid-input px-2 py-1 rounded-lg text-xs font-bold"
                        >
                          <option value="admin">Administrador</option>
                          <option value="member">Miembro</option>
                        </select>
                      ) : (
                        <span className="text-[11px] font-bold px-2 py-1 rounded-lg bg-slate-500/10 flex items-center gap-1">
                          {m.role === 'admin' && <Crown className="w-3 h-3 text-amber-500" />}
                          {m.role === 'admin' ? 'Admin' : 'Miembro'}
                        </span>
                      )}

                      {!isCurrent && !isCloud && (
                        <button
                          onClick={() => onSwitchCurrentMember(m.id)}
                          className="liquid-glass liquid-glass-interactive px-2.5 py-1 rounded-lg text-xs font-bold text-avocado-600 dark:text-avocado-400"
                        >
                          Usar perfil
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Invite / Add New Household Member */}
            {isCloud ? (
              <div className="pt-3 border-t border-[var(--glass-border)] space-y-2.5">
                <label className="text-sm font-bold text-[var(--text-secondary)] flex items-center gap-1.5">
                  <UserPlus className="w-4 h-4 text-avocado-600 dark:text-avocado-400" /> Invitar a alguien al hogar
                </label>
                <p className="text-xs text-[var(--text-muted)]">
                  Comparte el enlace o el código. Al abrirlo podrá crear su cuenta y entrar directo a
                  este hogar.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-h-[44px] px-3 rounded-xl liquid-glass-subtle flex items-center font-mono text-base font-bold tracking-wider">
                    {household.inviteCode}
                  </code>
                  <button
                    onClick={() => void handleCopyInvite()}
                    className="liquid-lens-btn min-h-[44px] px-4 rounded-xl text-sm font-bold flex items-center gap-1.5 shrink-0"
                  >
                    {copiedInvite ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    {copiedInvite ? 'Copiado' : 'Compartir'}
                  </button>
                </div>
              </div>
            ) : (
            <div className="pt-2.5 border-t border-[var(--glass-border)] space-y-2">
              <label className="text-xs font-bold text-[var(--text-secondary)] flex items-center gap-1.5">
                <UserPlus className="w-3.5 h-3.5 text-avocado-600 dark:text-avocado-400" /> Invitar Nuevo Miembro al Hogar
              </label>
              <form
                className="grid sm:grid-cols-[1fr_1fr_auto] gap-2 sm:items-end"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!isAdmin || !newMemberName.trim()) return;
                  onAddMember(
                    newMemberName.trim(),
                    newMemberEmail.trim() || `${newMemberName.toLowerCase().replace(/\s+/g, '')}@canastica.cr`
                  );
                  setNewMemberName('');
                  setNewMemberEmail('');
                }}
              >
                <Field label="Nombre">
                  {(id) => (
                    <TextInput
                      id={id}
                      disabled={!isAdmin}
                      value={newMemberName}
                      onChange={(e) => setNewMemberName(e.target.value)}
                      placeholder="Ej. Lucas Solís"
                      enterKeyHint="next"
                    />
                  )}
                </Field>
                <Field label="Correo (opcional)">
                  {(id) => (
                    <TextInput
                      id={id}
                      type="email"
                      inputMode="email"
                      disabled={!isAdmin}
                      value={newMemberEmail}
                      onChange={(e) => setNewMemberEmail(e.target.value)}
                      placeholder="lucas@hogar.cr"
                      enterKeyHint="done"
                    />
                  )}
                </Field>
                <Button type="submit" disabled={!isAdmin || !newMemberName.trim()} className="min-h-12">
                  <Plus className="w-4 h-4" /> Añadir
                </Button>
              </form>
            </div>
            )}
          </div>

          {/* Right: join another household + shortcut to settings (5 cols) */}
          <div className="lg:col-span-5 space-y-4">
            <div className="card p-5 space-y-4">
              <div>
                <h3 className="font-bold">Unirse a otro hogar</h3>
                <p className="text-sm text-[var(--text-muted)]">Pide el código a alguien de ese hogar.</p>
              </div>
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleJoin();
                }}
              >
                <Field label="Código de invitación" hint="Tiene la forma GLS-XXXXX.">
                  {(id) => (
                    <TextInput
                      id={id}
                      value={joinCodeInput}
                      onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                      placeholder="GLS-XXXXX"
                      autoCapitalize="characters"
                      autoComplete="off"
                      enterKeyHint="go"
                      className="font-mono uppercase tracking-wider"
                    />
                  )}
                </Field>
                <Button type="submit" variant="soft" block disabled={joinBusy || !joinCodeInput.trim()}>
                  Unirme al hogar
                </Button>
                {joinStatusMsg && (
                  <p className="text-sm text-avocado-700 dark:text-avocado-300 font-semibold" role="status">
                    {joinStatusMsg}
                  </p>
                )}
              </form>
            </div>
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                className="card w-full p-5 flex items-center gap-4 text-left hover:border-avocado-300 dark:hover:border-avocado-700 transition"
              >
                <span className="w-10 h-10 rounded-xl bg-avocado-50 dark:bg-avocado-500/10 text-avocado-700 dark:text-avocado-300 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-5 h-5" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-semibold">Presupuesto, roles y comercios</span>
                  <span className="block text-sm text-[var(--text-muted)]">Se cambian en Ajustes</span>
                </span>
                <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Copy, RefreshCw, Trash2, X } from 'lucide-react';
import {
  clearDevLog,
  devLog,
  formatDevLog,
  getDevContext,
  getDevLog,
  getDevStatus,
  subscribeDevConsole,
  type DevLogEntry,
} from '../lib/devConsole';
import {
  getAiQuota,
  getSupabaseClient,
  loadDevStatus,
  refreshAiQuota,
} from '../services/geminiAndSupabaseService';
import { listBugReports, type BugReportRow } from '../services/bugReportService';

const LEVEL_STYLES: Record<DevLogEntry['level'], string> = {
  info: 'text-sky-300',
  success: 'text-emerald-300',
  warn: 'text-amber-300',
  error: 'text-rose-300',
};

function Json({ value }: { value: unknown }) {
  return (
    <pre className="mt-1 text-[10px] leading-snug whitespace-pre-wrap break-all text-slate-300 bg-black/30 rounded p-2 max-h-64 overflow-auto">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function LogRow({ entry }: { entry: DevLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = entry.detail !== undefined && entry.detail !== null;
  return (
    <li className="border-b border-white/5 py-1.5">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className="w-full text-left flex items-start gap-2"
      >
        <span className="text-slate-500 shrink-0">{entry.time.slice(11, 19)}</span>
        <span className={`shrink-0 font-bold ${LEVEL_STYLES[entry.level]}`}>{entry.source}</span>
        <span className="flex-1 break-words">{entry.message}</span>
        {entry.durationMs !== undefined && (
          <span className="text-slate-500 shrink-0">{entry.durationMs} ms</span>
        )}
        {hasDetail && <span className="text-slate-500 shrink-0">{expanded ? '▾' : '▸'}</span>}
      </button>
      {expanded && <Json value={entry.detail} />}
    </li>
  );
}

function ReportsTab() {
  const [reports, setReports] = useState<BugReportRow[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    listBugReports().then((rows) => {
      if (active) setReports(rows);
    });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
      <button
        onClick={() => {
          setReports(null);
          setReloadKey((k) => k + 1);
        }}
        className="text-emerald-300 underline"
      >
        Recargar
      </button>
      {reports === null ? (
        <p className="py-6 text-center text-slate-500">Cargando…</p>
      ) : reports.length === 0 ? (
        <p className="py-6 text-center text-slate-500">Sin reportes.</p>
      ) : (
        reports.map((r) => (
          <details key={r.id} className="border border-white/10 rounded-lg p-2">
            <summary className="cursor-pointer">
              <span className="text-slate-500">{r.created_at.slice(0, 16).replace('T', ' ')}</span>{' '}
              <span className="text-sky-300">{r.user_email ?? '—'}</span>{' '}
              <span className="text-slate-400">{r.screen ?? ''}</span>{' '}
              <span className={r.email_status === 'sent' ? 'text-emerald-300' : 'text-amber-300'}>
                [{r.email_status}]
              </span>
              <span className="block text-slate-200 whitespace-pre-wrap">{r.description}</span>
            </summary>
            {r.screenshotUrl && (
              <a href={r.screenshotUrl} target="_blank" rel="noreferrer" className="block mt-2">
                <img src={r.screenshotUrl} alt="Captura del reporte" className="max-h-48 rounded" />
              </a>
            )}
            <Json value={r.context} />
          </details>
        ))
      )}
    </div>
  );
}

export default function DevConsolePanel({ onClose }: { onClose: () => void }) {
  // Re-render on any log/status change
  useSyncExternalStore(subscribeDevConsole, getDevLog);
  const entries = getDevLog();
  const status = getDevStatus();
  const context = getDevContext();
  const [tab, setTab] = useState<'log' | 'config' | 'reports'>('log');
  const [filter, setFilter] = useState<'all' | 'error'>('all');
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);

  const visible = filter === 'error' ? entries.filter((e) => e.level === 'error' || e.level === 'warn') : entries;

  const clientConfig = {
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL || '(sin configurar)',
    origin: window.location.origin,
    buildMode: import.meta.env.MODE,
    online: navigator.onLine,
    userAgent: navigator.userAgent,
    user: { id: context.userId, email: context.email },
    householdId: context.householdId,
    aiQuota: getAiQuota(),
  };

  const runConnectionTests = async () => {
    setTesting(true);
    devLog('info', 'Prueba', 'Probando conexiones…');
    try {
      await loadDevStatus();
      await refreshAiQuota();
      const sb = getSupabaseClient();
      if (sb) {
        const started = performance.now();
        const { error, count } = await sb
          .from('household_members')
          .select('household_id', { count: 'exact', head: true });
        devLog(error ? 'error' : 'success', 'Prueba', error ? `Consulta a la base: ${error.message}` : `Consulta a la base OK (${count ?? 0} membresías)`, {
          durationMs: Math.round(performance.now() - started),
          detail: error ?? undefined,
        });
        const authStart = performance.now();
        const { data, error: authError } = await sb.auth.getUser();
        devLog(authError ? 'error' : 'success', 'Prueba', authError ? `Sesión: ${authError.message}` : `Sesión OK (${data.user?.email})`, {
          durationMs: Math.round(performance.now() - authStart),
        });
      }
    } finally {
      setTesting(false);
    }
  };

  const copyLog = async () => {
    const text = `${formatDevLog()}\n\n--- Configuración ---\n${JSON.stringify({ server: status?.config, client: clientConfig }, null, 2)}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      devLog('warn', 'Consola', 'No se pudo copiar al portapapeles');
    }
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-[95] sm:inset-auto sm:right-4 sm:bottom-4 sm:w-[560px] h-[70dvh] sm:h-[600px] bg-slate-950/95 text-slate-100 border border-emerald-500/30 rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col font-mono text-[11px] backdrop-blur">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
        <span className="font-bold text-emerald-300">Consola developer</span>
        <div className="flex gap-1 ml-2">
          {(['log', 'config', 'reports'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2 py-1 rounded ${tab === t ? 'bg-emerald-500/20 text-emerald-200' : 'text-slate-400'}`}
            >
              {t === 'log' ? `Registro (${entries.length})` : t === 'config' ? 'Configuración' : 'Reportes'}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => void runConnectionTests()} disabled={testing} className="p-1.5 rounded hover:bg-white/10" title="Probar conexiones">
            <RefreshCw className={`w-4 h-4 ${testing ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={() => void copyLog()} className="p-1.5 rounded hover:bg-white/10" title="Copiar registro">
            <Copy className={`w-4 h-4 ${copied ? 'text-emerald-300' : ''}`} />
          </button>
          <button onClick={clearDevLog} className="p-1.5 rounded hover:bg-white/10" title="Limpiar">
            <Trash2 className="w-4 h-4" />
          </button>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-white/10" aria-label="Cerrar consola">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {tab === 'reports' ? (
        <ReportsTab />
      ) : tab === 'log' ? (
        <>
          <div className="flex gap-2 px-3 py-1.5 border-b border-white/5 text-slate-400">
            <button onClick={() => setFilter('all')} className={filter === 'all' ? 'text-slate-100 underline' : ''}>
              Todo
            </button>
            <button onClick={() => setFilter('error')} className={filter === 'error' ? 'text-slate-100 underline' : ''}>
              Errores y avisos
            </button>
          </div>
          <ul className="flex-1 overflow-y-auto px-3">
            {visible.length === 0 ? (
              <li className="py-6 text-center text-slate-500">Sin eventos todavía.</li>
            ) : (
              visible.map((e) => <LogRow key={e.id} entry={e} />)
            )}
          </ul>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
          <section>
            <h4 className="font-bold text-emerald-300">Servidor (dev-status)</h4>
            <Json value={status?.config ?? 'Sin datos: pulsa "Probar conexiones"'} />
          </section>
          <section>
            <h4 className="font-bold text-emerald-300">Cliente</h4>
            <Json value={clientConfig} />
          </section>
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export type SheetSize = 'sm' | 'md' | 'lg' | 'xl';

interface SheetProps {
  open?: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Small icon shown before the title */
  icon?: React.ReactNode;
  size?: SheetSize;
  /** Sticky actions at the bottom (always visible, even with the keyboard open) */
  footer?: React.ReactNode;
  /** On phones, take the whole screen height instead of growing with the content */
  tall?: boolean;
  /** Extra controls next to the close button */
  headerAction?: React.ReactNode;
  /** Remove the default body padding (for content that manages its own) */
  flush?: boolean;
  zIndex?: string;
  children: React.ReactNode;
}

const SIZE: Record<SheetSize, string> = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-5xl',
};

/**
 * The one container for every form and detail panel.
 * Phone: bottom sheet. Tablet/desktop: centered dialog.
 * Only the body scrolls (never nested scroll areas); the footer stays pinned
 * so the main action is always under the thumb.
 */
export const Sheet: React.FC<SheetProps> = ({
  open = true,
  onClose,
  title,
  subtitle,
  icon,
  size = 'md',
  footer,
  tall = false,
  headerAction,
  flush = false,
  zIndex = 'z-[60]',
  children,
}) => {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    // Keep the page behind still while the sheet is open
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!open) return null;

  // Portal: a transformed/animated ancestor would otherwise trap the fixed overlay
  return createPortal(
    <div className={`fixed inset-0 ${zIndex} flex items-end sm:items-center justify-center sm:p-6`}>
      <div className="absolute inset-0 bg-[#0d1508]/45 backdrop-blur-[2px] animate-fade-in" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative w-full ${SIZE[size]} flex flex-col bg-[var(--bg-primary)] text-[var(--text-primary)] rounded-t-[28px] sm:rounded-3xl shadow-2xl ring-1 ring-black/5 dark:ring-white/10 animate-sheet-in ${
          tall
            ? 'h-[calc(100dvh-env(safe-area-inset-top)-10px)] sm:h-auto sm:max-h-[min(92dvh,960px)]'
            : 'max-h-[calc(100dvh-env(safe-area-inset-top)-10px)] sm:max-h-[min(90dvh,900px)]'
        }`}
      >
        <div className="sm:hidden pt-2.5 pb-0.5 flex justify-center shrink-0" aria-hidden="true">
          <span className="w-10 h-1.5 rounded-full bg-black/15 dark:bg-white/20" />
        </div>
        <header className="shrink-0 flex items-center gap-3 px-4 sm:px-6 pt-2 sm:pt-5 pb-3">
          {icon && (
            <span className="w-10 h-10 rounded-2xl bg-avocado-100 text-avocado-700 dark:bg-avocado-500/15 dark:text-avocado-300 flex items-center justify-center shrink-0">
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-bold tracking-tight leading-tight truncate">
              {title}
            </h2>
            {subtitle && <p className="text-sm text-[var(--text-muted)] truncate">{subtitle}</p>}
          </div>
          {headerAction}
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-full flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)] shrink-0"
            aria-label="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>
        </header>
        <div
          className={`flex-1 min-h-0 overflow-y-auto overscroll-contain ${
            flush ? '' : 'px-4 sm:px-6 pb-5'
          } ${footer ? '' : 'pb-[calc(env(safe-area-inset-bottom)+20px)] sm:pb-6'}`}
        >
          {children}
        </div>
        {footer && (
          <footer className="shrink-0 border-t border-[var(--glass-border)] px-4 sm:px-6 pt-3 pb-[calc(env(safe-area-inset-bottom)+12px)] sm:pb-4 bg-[var(--bg-primary)] rounded-b-none sm:rounded-b-3xl">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body
  );
};

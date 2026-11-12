import React from 'react';
import { Download, Eye, FileText } from 'lucide-react';
import { InboundFile } from '../services/inboundInvoicesService';

interface InvoiceFilesListProps {
  files: InboundFile[];
  onOpen: (file: InboundFile, download: boolean) => void;
  compact?: boolean;
}

/** Original files of an email invoice (XML, Hacienda response, PDF), each viewable and downloadable. */
export const InvoiceFilesList: React.FC<InvoiceFilesListProps> = ({ files, onOpen, compact }) => {
  if (files.length === 0) return null;
  return (
    <ul className={`w-full space-y-1 ${compact ? 'mt-1' : 'mt-2'}`}>
      {files.map((f) => (
        <li key={f.part} className="flex items-center gap-1.5 text-[11px]">
          <FileText className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
          <span className="flex-1 min-w-0 truncate font-semibold" title={f.name}>
            {f.label}
          </span>
          <button
            onClick={() => onOpen(f, false)}
            aria-label={`Ver ${f.label}`}
            className="min-h-[32px] px-2 rounded-lg liquid-glass liquid-glass-interactive font-bold flex items-center gap-1 shrink-0"
          >
            <Eye className="w-3.5 h-3.5" /> Ver
          </button>
          <button
            onClick={() => onOpen(f, true)}
            aria-label={`Descargar ${f.name}`}
            className="min-h-[32px] px-2 rounded-lg liquid-glass liquid-glass-interactive font-bold flex items-center gap-1 shrink-0"
          >
            <Download className="w-3.5 h-3.5" /> Descargar
          </button>
        </li>
      ))}
    </ul>
  );
};

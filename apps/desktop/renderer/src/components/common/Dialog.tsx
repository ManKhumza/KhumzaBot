import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { clsx } from 'clsx';
import { createPortal } from 'react-dom';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export const Dialog = ({ open, onOpenChange, title, description, children, className }: DialogProps) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const content = contentRef.current;
    if (content && !content.contains(document.activeElement)) {
      (content.querySelector<HTMLElement>('input:not([disabled]),button:not([disabled]),[tabindex="0"]') || content).focus();
    }
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [open]);
  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onOpenChange(false);
    if (e.key === 'Tab') {
      const focusable = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]') || []).filter(element => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };

  const content = (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} aria-describedby={description ? descriptionId : undefined}>
      <div
        className="fixed inset-0 bg-black/50 animate-in"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />
      <div
        ref={contentRef}
        tabIndex={-1}
        className={clsx(
          'relative z-50 max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-lg animate-in fade-in-0 zoom-in-95',
          className
        )}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => onOpenChange(false)}
          className="absolute right-4 top-4 rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
        {title && <h2 id={titleId} className="text-lg font-semibold text-foreground mb-1">{title}</h2>}
        {description && <p id={descriptionId} className="text-sm text-muted-foreground mb-4">{description}</p>}
        {children}
      </div>
    </div>
  );

  return createPortal(content, document.body);
};

interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  variant?: 'destructive' | 'default';
}

export const AlertDialog = ({ open, onOpenChange, title, description, confirmText = 'Confirm', cancelText = 'Cancel', onConfirm, variant = 'default' }: AlertDialogProps) => {
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="alertdialog" aria-modal="true">
      <div className="fixed inset-0 bg-black/50 animate-in" onClick={() => onOpenChange(false)} />
      <div className="relative z-50 w-[calc(100%-2rem)] max-w-md rounded-lg border border-border bg-card p-6 shadow-lg animate-in fade-in-0 zoom-in-95">
        <h2 className="text-lg font-semibold text-foreground mb-1">{title}</h2>
        {description && <p className="text-sm text-muted-foreground mb-6">{description}</p>}
        <div className="flex justify-end gap-3">
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-secondary text-secondary-foreground hover:bg-secondary/80"
          >
            {cancelText}
          </button>
          <button
            onClick={() => { onConfirm(); onOpenChange(false); }}
            className={clsx(
              'px-4 py-2 text-sm font-medium rounded-lg',
              variant === 'destructive'
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

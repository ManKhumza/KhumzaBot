import React, { Fragment } from 'react';
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
  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onOpenChange(false);
  };

  const content = (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby={title ? 'dialog-title' : undefined} aria-describedby={description ? 'dialog-description' : undefined}>
      <div
        className="fixed inset-0 bg-black/50 animate-in"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />
      <div
        className={clsx(
          'relative z-50 w-full max-w-lg rounded-xl bg-card p-6 shadow-lg animate-in fade-in-0 zoom-in-95',
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
        {title && <h2 id="dialog-title" className="text-lg font-semibold text-foreground mb-1">{title}</h2>}
        {description && <p id="dialog-description" className="text-sm text-muted-foreground mb-4">{description}</p>}
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
      <div className="relative z-50 w-full max-w-md rounded-xl bg-card p-6 shadow-lg animate-in fade-in-0 zoom-in-95">
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
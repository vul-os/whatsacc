import { useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Modal({
  open,
  onClose,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-ink/60 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal
        className={cn(
          'relative w-full sm:max-w-md bg-paper rounded-t-3xl sm:rounded-3xl p-6 shadow-[0_24px_64px_-24px_rgba(0,0,0,0.5)]',
          'max-h-[calc(100svh-1rem)] sm:max-h-[calc(100svh-2rem)] overflow-y-auto',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

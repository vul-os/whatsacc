import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

// Bottom-sheet on mobile, centred panel on desktop. The panel is positioned
// with explicit top/bottom + translate (not flex centering) so it always sits
// inside the viewport — content scrolls inside the panel, never spills off
// the edges. Portalled to <body> so transformed ancestors can't break
// `position: fixed`.
export function Modal({
  open,
  onClose,
  children,
  className,
  /** drop the default p-6 padding so consumers can manage their own
   *  scrolling/sticky regions inside the dialog box. */
  padded = true,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="modal-root fixed inset-0 z-50" role="presentation">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 w-full h-full bg-ink/60 backdrop-blur-sm"
      />

      <div
        role="dialog"
        aria-modal
        className={cn(
          'modal-panel absolute',
          // mobile: pinned to the bottom edge, full-width (sheet)
          'left-0 right-0 bottom-0',
          // desktop: explicitly centred via translate
          'sm:left-1/2 sm:right-auto sm:top-1/2 sm:bottom-auto sm:-translate-x-1/2 sm:-translate-y-1/2',
          'w-full sm:max-w-md',
          'bg-paper rounded-t-3xl sm:rounded-3xl shadow-[0_24px_64px_-24px_rgba(0,0,0,0.5)]',
          // height cap — panel can't exceed viewport. Inside scrolls.
          'max-h-[calc(100svh-1rem)] sm:max-h-[calc(100svh-4rem)]',
          'overflow-y-auto overscroll-contain',
          padded && 'p-6',
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

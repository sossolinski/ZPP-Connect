import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

type CloseReason = "escape" | "backdrop" | "close-button";
type DialogControls = { requestClose: (reason?: CloseReason) => void };

const dialogStack: symbol[] = [];
let bodyLockCount = 0;
let previousBodyOverflow = "";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function lockBody() {
  if (bodyLockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyLockCount += 1;
}

function unlockBody() {
  bodyLockCount = Math.max(0, bodyLockCount - 1);
  if (bodyLockCount === 0) document.body.style.overflow = previousBodyOverflow;
}

function isTopDialog(id: symbol) {
  return dialogStack[dialogStack.length - 1] === id;
}

export function DialogSurface({
  title,
  description,
  onClose,
  dirty = false,
  busy = false,
  children,
  className,
  layer = "base",
  initialFocus = "heading"
}: {
  title: string;
  description?: string;
  onClose: () => void;
  dirty?: boolean;
  busy?: boolean;
  children: ReactNode | ((controls: DialogControls) => ReactNode);
  className: string;
  layer?: "base" | "nested";
  initialFocus?: "heading" | "first-control";
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const stackIdRef = useRef(Symbol("dialog"));
  const historyGuardIdRef = useRef(`dialog-${Math.random().toString(36).slice(2)}`);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [blockedMessage, setBlockedMessage] = useState("");

  const requestClose = useCallback((reason: CloseReason = "close-button") => {
    if (busy) {
      setBlockedMessage(`Please wait. ${title} is processing and cannot be closed yet.`);
      return;
    }
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  }, [busy, dirty, onClose, title]);

  useEffect(() => {
    const id = stackIdRef.current;
    dialogStack.push(id);
    lockBody();
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const requested = initialFocus === "first-control"
        ? dialog.querySelector<HTMLElement>("[data-dialog-initial-focus='true']") ?? dialog.querySelector<HTMLElement>(focusableSelector)
        : dialog.querySelector<HTMLElement>("[data-dialog-heading='true']") ?? dialog.querySelector<HTMLElement>("[data-dialog-initial-focus='true']");
      (requested ?? dialog).focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      const index = dialogStack.lastIndexOf(id);
      if (index >= 0) dialogStack.splice(index, 1);
      unlockBody();
      const opener = openerRef.current;
      window.requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus();
        else document.querySelector<HTMLElement>("main h1, main [role='heading'], main")?.focus();
      });
    };
  }, [initialFocus]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const guardId = historyGuardIdRef.current;
    const guardState = { ...(window.history.state ?? {}), __zppDialogGuard: guardId };
    window.history.pushState(guardState, "", window.location.href);
    const onPopState = () => {
      setDiscardOpen(true);
      window.history.pushState(guardState, "", window.location.href);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      if (window.history.state?.__zppDialogGuard === guardId) window.history.back();
    };
  }, [dirty]);

  useEffect(() => {
    const id = stackIdRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopDialog(id)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose("escape");
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && (activeIndex <= 0 || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [requestClose]);

  const renderedChildren = typeof children === "function" ? children({ requestClose }) : children;
  const zBackdrop = layer === "nested" ? "z-[80]" : "z-40";

  return (
    <>
      <div aria-hidden="true" className={`fixed inset-0 ${zBackdrop} bg-slate-950/30`} onMouseDown={(event) => event.target === event.currentTarget && requestClose("backdrop")} />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className={className}
      >
        <span id={titleId} className="sr-only">{title}</span>
        {description ? <p id={descriptionId} className="sr-only">{description}</p> : null}
        {renderedChildren}
        <p className="sr-only" role="status" aria-live="assertive">{blockedMessage}</p>
      </section>

      {discardOpen ? (
        <DialogSurface
          title="Discard unsaved changes?"
          description={`Unsaved changes in ${title} will be lost.`}
          onClose={() => setDiscardOpen(false)}
          className="fixed left-1/2 top-1/2 z-[90] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-foreground shadow-2xl"
          layer="nested"
          initialFocus="first-control"
        >
          {({ requestClose: closeConfirmation }) => (
            <div className="grid gap-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                <div>
                  <h3 data-dialog-heading="true" tabIndex={-1} className="font-black text-foreground">Discard unsaved changes?</h3>
                  <p className="mt-1 text-sm font-semibold leading-6 text-muted-foreground">Your entered values will be lost. This action cannot be undone.</p>
                </div>
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button data-dialog-initial-focus="true" type="button" className="focus-ring h-9 rounded-md border border-border bg-card px-3 text-sm font-bold text-foreground hover:bg-muted" onClick={() => closeConfirmation()}>Continue editing</button>
                <button type="button" className="focus-ring h-9 rounded-md border border-red-700 bg-red-700 px-3 text-sm font-bold text-white hover:bg-red-800" onClick={onClose}>Discard changes</button>
              </div>
            </div>
          )}
        </DialogSurface>
      ) : null}
    </>
  );
}

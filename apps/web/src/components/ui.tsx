import { clsx } from "clsx";
import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState, type ComponentType, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, Loader2, X, XCircle } from "lucide-react";
import { DialogSurface } from "./DialogSurface";

type SortDirection = "asc" | "desc";
type ButtonVariant = "primary" | "secondary" | "create" | "success" | "warning" | "danger" | "ghost";
type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "exercise";
type TableColumn = {
  key: string;
  label: string;
  render?: (row: Record<string, any>) => ReactNode;
  className?: string;
  sortable?: boolean;
};

export function Button({
  children,
  variant = "secondary",
  size = "md",
  icon: Icon,
  className,
  disabled,
  ...props
}: {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: "sm" | "md" | "icon";
  icon?: ComponentType<{ className?: string }>;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const variants = {
    primary: "border-[#0B1F3A] bg-[#0B1F3A] text-white shadow-sm shadow-slate-950/10 hover:border-[#145C63] hover:bg-[#145C63]",
    secondary: "border-border bg-card text-foreground shadow-sm shadow-slate-950/[0.03] hover:bg-muted",
    create: "border-[#145C63] bg-[#145C63] text-white shadow-sm shadow-[#145C63]/20 hover:border-[#0F4F55] hover:bg-[#0F4F55]",
    success: "bg-emerald-700 text-white hover:bg-emerald-800 border-emerald-700",
    warning: "bg-amber-500 text-slate-950 hover:bg-amber-600 border-amber-500",
    danger: "bg-red-700 text-white hover:bg-red-800 border-red-700",
    ghost: "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
  };
  const sizes = {
    sm: "h-8 min-w-8 px-2.5 text-sm",
    md: "h-9 min-w-9 px-3 text-sm",
    icon: "h-8 w-8 px-0"
  };
  return (
    <button
      className={clsx(
        "focus-ring inline-flex items-center justify-center gap-2 rounded-md border font-bold transition disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        sizes[size],
        className
      )}
      disabled={disabled}
      {...props}
    >
      {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
      {children}
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={clsx("min-w-0 rounded-lg border border-border bg-card text-foreground shadow-panel", className)}>{children}</section>;
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-border bg-muted px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h2 className="truncate text-base font-black text-foreground">{title}</h2>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
  title
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  title?: string;
}) {
  const tones = {
    neutral: "border-border bg-card text-muted-foreground shadow-sm shadow-slate-950/[0.02]",
    info: "border-[#145C63]/25 bg-[#145C63]/10 text-[#145C63]",
    success: "bg-emerald-50 text-emerald-800 border-emerald-200",
    warning: "bg-amber-50 text-amber-900 border-amber-200",
    danger: "bg-red-50 text-red-800 border-red-200",
    exercise: "border-border bg-muted text-muted-foreground"
  };
  return (
    <span title={title} className={clsx("inline-flex max-w-full items-center overflow-hidden whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-bold leading-5", tones[tone], className)}>
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

const statusToneByValue: Record<string, BadgeTone> = {
  active: "info",
  accepted: "success",
  archived: "neutral",
  assigned: "info",
  blocked: "danger",
  cancelled: "danger",
  closed: "success",
  complete: "success",
  completed: "success",
  confirmed: "success",
  current: "success",
  critical: "danger",
  disputed: "warning",
  done: "success",
  draft: "neutral",
  escalated: "warning",
  exercise: "exercise",
  high: "warning",
  "hold / escalate": "warning",
  "identity verification hold": "warning",
  incomplete: "warning",
  "in progress": "info",
  invalid: "danger",
  "legal hold": "warning",
  low: "neutral",
  "medical confidentiality hold": "warning",
  new: "info",
  "no hold": "success",
  normal: "neutral",
  "not confirmed": "warning",
  "not verified": "warning",
  "other hold": "warning",
  overdue: "danger",
  partially: "warning",
  "partially covered": "warning",
  "partially verified": "warning",
  paused: "warning",
  pending: "warning",
  "potential match": "info",
  prepared: "info",
  rejected: "danger",
  revoked: "danger",
  released: "success",
  reunited: "success",
  required: "warning",
  "review due": "warning",
  "security hold": "warning",
  suggested: "info",
  training: "exercise",
  unconfirmed: "warning",
  unverified: "warning",
  urgent: "warning",
  "urgent welfare": "warning",
  validated: "success",
  "validated with errors": "warning",
  verified: "success",
  "verified match": "success",
  waiting: "warning"
};

function normalizeStatus(value?: string | null) {
  return String(value ?? "Unknown").trim().toLowerCase().replace(/\s+/g, " ");
}

export function StatusBadge({ value, className }: { value?: string | null; className?: string }) {
  const text = value ?? "Unknown";
  const tone = statusToneByValue[normalizeStatus(text)] ?? "neutral";
  return <Badge tone={tone} className={clsx("whitespace-nowrap", className)} title={text}>{text}</Badge>;
}

export function Field({
  label,
  children,
  required,
  helperText,
  error,
  id
}: {
  label: string;
  children: ReactNode;
  required?: boolean;
  helperText?: string;
  error?: string;
  id?: string;
}) {
  const generatedId = useId();
  const fieldId = id ?? `field-${generatedId.replace(/:/g, "")}`;
  const helpId = helperText ? `${fieldId}-help` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;
  let connected = false;
  const connectControl = (node: ReactNode): ReactNode => {
    if (!isValidElement(node)) return node;
    const element = node as ReactElement<Record<string, any>>;
    const type = element.type;
    const isControl = type === Input || type === Select || type === Textarea || (typeof type === "string" && ["input", "select", "textarea"].includes(type));
    if (!connected && isControl) {
      connected = true;
      return cloneElement(element, {
        id: fieldId,
        required: element.props.required ?? required,
        "aria-required": required || undefined,
        "aria-invalid": Boolean(error) || undefined,
        "aria-describedby": [element.props["aria-describedby"], describedBy].filter(Boolean).join(" ") || undefined
      });
    }
    if (element.props.children !== undefined) {
      return cloneElement(element, { children: Children.map(element.props.children, connectControl) });
    }
    return element;
  };
  const control = Children.map(children, connectControl);
  return (
    <div className="grid content-start gap-1.5 text-sm font-semibold text-muted-foreground">
      <label htmlFor={fieldId}>
        {label}
        {required ? <span className="ml-1 text-red-700">(required)</span> : null}
      </label>
      {control}
      {helperText ? <p id={helpId} className="text-xs font-semibold leading-5 text-muted-foreground">{helperText}</p> : null}
      {error ? <p id={errorId} role="alert" className="text-xs font-bold leading-5 text-red-700">{error}</p> : null}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={clsx("focus-ring h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground shadow-sm shadow-slate-950/[0.02] placeholder:text-muted-foreground hover:border-ring focus:border-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground read-only:bg-muted/60 read-only:text-foreground aria-invalid:border-red-600", className)}
      {...props}
    />
  );
}

export function Select({ children, className, readOnly, onMouseDown, onKeyDown, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { readOnly?: boolean }) {
  return (
    <select
      aria-readonly={readOnly || undefined}
      className={clsx("focus-ring h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground shadow-sm shadow-slate-950/[0.02] hover:border-ring focus:border-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground", readOnly ? "cursor-default bg-muted/60" : "", className)}
      onMouseDown={(event) => { if (readOnly) event.preventDefault(); onMouseDown?.(event); }}
      onKeyDown={(event) => { if (readOnly && !["Tab", "Shift"].includes(event.key)) event.preventDefault(); onKeyDown?.(event); }}
      {...props}
    >
      {children}
    </select>
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={clsx("focus-ring min-h-24 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground shadow-sm shadow-slate-950/[0.02] placeholder:text-muted-foreground hover:border-ring focus:border-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground", className)}
      {...props}
    />
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  const isError = title.toLowerCase().startsWith("unable") || title.toLowerCase().includes("failed");
  return (
    <div role={isError ? "alert" : "status"} className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-border bg-muted px-4 text-center">
      <div>
        <p className="font-semibold text-foreground">{title}</p>
        {detail ? <p className="mt-1 text-sm text-muted-foreground">{detail}</p> : null}
        {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function AlertBox({
  children,
  tone = "warning",
  dismissible = false,
  className
}: {
  children: ReactNode;
  tone?: "warning" | "success" | "danger";
  dismissible?: boolean;
  className?: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  const Icon = tone === "warning" ? AlertTriangle : tone === "danger" ? XCircle : CheckCircle2;
  useEffect(() => setDismissed(false), [children, tone]);
  if (dismissed) return null;
  const isAlert = tone === "warning" || tone === "danger";
  const toneClass =
    tone === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100"
      : tone === "danger"
        ? "border-red-200 bg-red-50 text-red-950 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-100"
        : "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-100";
  return (
    <div
      role={isAlert ? "alert" : "status"}
      aria-live={isAlert ? "assertive" : "polite"}
      className={clsx(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        toneClass,
        className
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {dismissible ? (
        <button
          type="button"
          className={clsx(
            "focus-ring -mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
            tone === "warning" ? "text-amber-900 hover:bg-amber-100" : tone === "danger" ? "text-red-900 hover:bg-red-100" : "text-emerald-900 hover:bg-emerald-100"
          )}
          aria-label="Dismiss message"
          onClick={() => setDismissed(true)}
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

export function ErrorSummary({ title = "Please correct the following", errors, focus = true }: { title?: string; errors: Array<{ message: string; fieldId?: string }>; focus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const signature = errors.map((item) => `${item.fieldId}:${item.message}`).join("|");
  useEffect(() => {
    if (focus && errors.length) ref.current?.focus();
  }, [focus, signature]);
  if (!errors.length) return null;
  return (
    <div ref={ref} tabIndex={-1} role="alert" aria-live="assertive" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-950">
      <p className="font-black">{title}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 font-semibold">
        {errors.map((item, index) => (
          <li key={`${item.fieldId ?? index}-${item.message}`}>
            {item.fieldId ? <a className="underline underline-offset-2" href={`#${item.fieldId}`} onClick={() => window.requestAnimationFrame(() => document.getElementById(item.fieldId!)?.focus())}>{item.message}</a> : item.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DecisionDialog({
  title,
  description,
  label,
  value,
  onChange,
  onCancel,
  onConfirm,
  confirmLabel,
  confirmIcon,
  confirmVariant = "primary",
  error,
  busy,
  required,
  placeholder
}: {
  title: string;
  description?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  confirmLabel: string;
  confirmIcon?: ComponentType<{ className?: string }>;
  confirmVariant?: ButtonVariant;
  error?: string;
  busy?: boolean;
  required?: boolean;
  placeholder?: string;
}) {
  const initialValueRef = useRef(value);
  return (
    <DialogSurface
      title={title}
      description={description}
      onClose={onCancel}
      busy={busy}
      dirty={value !== initialValueRef.current}
      layer="nested"
      initialFocus="first-control"
      className="fixed left-1/2 top-1/2 z-[90] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card text-foreground shadow-2xl"
    >
      {({ requestClose }) => (
        <form
          className="grid gap-4 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void onConfirm();
          }}
        >
          <div className="min-w-0">
            <h2 data-dialog-heading="true" tabIndex={-1} className="text-lg font-black text-foreground">{title}</h2>
            {description ? <p className="mt-1 text-sm font-semibold leading-6 text-muted-foreground">{description}</p> : null}
          </div>
          <ErrorSummary title="Decision could not be submitted" errors={error ? [{ message: error, fieldId: "decision-note" }] : []} />
          <Field id="decision-note" label={label} required={required} error={error}>
            <Textarea
              value={value}
              disabled={busy}
              placeholder={placeholder}
              onChange={(event) => onChange(event.target.value)}
            />
          </Field>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button data-dialog-initial-focus="true" type="button" variant="secondary" disabled={busy} onClick={() => requestClose()}>
              Cancel
            </Button>
            <Button type="submit" variant={confirmVariant} icon={confirmIcon} disabled={busy}>
              {busy ? "Saving..." : confirmLabel}
            </Button>
          </div>
        </form>
      )}
    </DialogSurface>
  );
}

export function ConfirmDialog({
  title,
  description,
  recordLabel,
  confirmLabel,
  confirmVariant = "primary",
  confirmIcon,
  busy,
  error,
  onCancel,
  onConfirm
}: {
  title: string;
  description: string;
  recordLabel?: string;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  confirmIcon?: ComponentType<{ className?: string }>;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <DialogSurface
      title={title}
      description={description}
      onClose={onCancel}
      busy={busy}
      layer="nested"
      initialFocus="first-control"
      className="fixed left-1/2 top-1/2 z-[90] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-foreground shadow-2xl"
    >
      {({ requestClose }) => (
        <div className="grid gap-4">
          <div>
            <h2 data-dialog-heading="true" tabIndex={-1} className="text-lg font-black text-foreground">{title}</h2>
            {recordLabel ? <p className="mt-1 break-words text-sm font-black text-foreground">{recordLabel}</p> : null}
            <p className="mt-2 text-sm font-semibold leading-6 text-muted-foreground">{description}</p>
          </div>
          <ErrorSummary title="Action could not be completed" errors={error ? [{ message: error }] : []} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button data-dialog-initial-focus="true" type="button" variant="secondary" disabled={busy} onClick={() => requestClose()}>Cancel</Button>
            <Button type="button" variant={confirmVariant} icon={confirmIcon} disabled={busy} aria-busy={busy} onClick={() => void onConfirm()}>{busy ? "Working" : confirmLabel}</Button>
          </div>
        </div>
      )}
    </DialogSurface>
  );
}

export function Table({
  columns,
  rows,
  rowAction,
  minWidth = "min-w-full w-full",
  actionWidth = "w-28",
  sortKey,
  sortDirection,
  onSort,
  rowId,
  rowClassName,
  emptyTitle = "No records",
  emptyDetail = "Records created in this module will appear here.",
  emptyAction,
  onRowOpen,
  rowLabel
}: {
  columns: TableColumn[];
  rows: Array<Record<string, any>>;
  rowAction?: (row: Record<string, any>) => ReactNode;
  minWidth?: string;
  actionWidth?: string;
  sortKey?: string;
  sortDirection?: SortDirection;
  onSort?: (key: string) => void;
  rowId?: (row: Record<string, any>) => string | undefined;
  rowClassName?: (row: Record<string, any>) => string | undefined;
  emptyTitle?: string;
  emptyDetail?: string;
  emptyAction?: ReactNode;
  onRowOpen?: (row: Record<string, any>) => void;
  rowLabel?: (row: Record<string, any>) => string;
}) {
  if (rows.length === 0) return <EmptyState title={emptyTitle} detail={emptyDetail} action={emptyAction} />;
  return (
    <div className="scrollbar-soft min-w-0 overflow-x-auto rounded-lg border border-border bg-card">
      <table className={clsx("table-fixed border-separate border-spacing-0 text-left text-sm", minWidth)}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                aria-sort={onSort && column.sortable !== false && sortKey === column.key ? (sortDirection === "asc" ? "ascending" : "descending") : undefined}
                className={clsx(
                  "sticky top-0 overflow-hidden border-b border-border bg-muted px-3 py-2.5 text-[11px] font-black uppercase tracking-wide text-muted-foreground",
                  column.className
                )}
              >
                {onSort && column.sortable !== false ? (
                  <button
                    type="button"
                    className="focus-ring -mx-1 flex h-7 max-w-full items-center gap-1 rounded px-1 text-left uppercase tracking-wide hover:text-foreground"
                    onClick={() => onSort(column.key)}
                    aria-label={`Sort by ${column.label}${sortKey === column.key ? `, currently ${sortDirection === "asc" ? "ascending" : "descending"}` : ""}`}
                  >
                    <span className="block truncate">{column.label}</span>
                    {sortKey === column.key ? (
                      sortDirection === "asc" ? <ArrowUp className="h-3.5 w-3.5 shrink-0" /> : <ArrowDown className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                ) : (
                  <span className="block truncate">{column.label}</span>
                )}
              </th>
            ))}
            {rowAction ? (
              <th className={clsx("sticky right-0 top-0 z-10 border-b border-border bg-muted px-3 py-2.5 text-[11px] font-black uppercase tracking-wide text-muted-foreground shadow-[-10px_0_14px_-16px_rgba(15,23,42,0.65)]", actionWidth)}>
                Actions
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              id={rowId?.(row)}
              key={String(row.id ?? row.operationalId)}
              tabIndex={onRowOpen ? 0 : undefined}
              aria-label={onRowOpen ? rowLabel?.(row) ?? `Open ${String(row.operationalId ?? row.id ?? "record")}` : undefined}
              onClick={onRowOpen ? (event) => {
                if ((event.target as HTMLElement).closest("button, a, input, select, textarea")) return;
                onRowOpen(row);
              } : undefined}
              onKeyDown={onRowOpen ? (event) => {
                if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                event.preventDefault();
                onRowOpen(row);
              } : undefined}
              className={clsx("group odd:bg-card even:bg-muted", rowAction || onRowOpen ? "cursor-pointer hover:bg-[#145C63]/5" : "", rowClassName?.(row))}
            >
              {columns.map((column) => (
                <td key={column.key} className={clsx("overflow-hidden border-b border-border px-3 py-3 align-middle text-foreground", column.className)}>
                  <div
                    className={clsx(
                      "line-clamp-2 min-w-0 break-words leading-5",
                      column.key === "operationalId" ? "whitespace-nowrap font-bold text-foreground" : ""
                    )}
                  >
                    {column.render ? column.render(row) : String(row[column.key] ?? "")}
                  </div>
                </td>
              ))}
              {rowAction ? (
                <td className={clsx("sticky right-0 z-[1] border-b border-border bg-card px-3 py-3 align-middle shadow-[-10px_0_14px_-16px_rgba(15,23,42,0.65)] group-even:bg-muted group-hover:bg-[#145C63]/5", actionWidth)}>
                  {rowAction(row)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

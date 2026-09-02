import type {
  ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "~/lib/cn.ts";

export const Card = ({ className, children, ...props }:
  HTMLAttributes<HTMLDivElement> & { children: ReactNode }) => (
  <div className={cn("rounded-xl border border-line/60 bg-surface/70 backdrop-blur", className)} {...props}>
    {children}
  </div>
);

export const Button = ({ className, variant = "solid", ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "solid" | "ghost" | "danger" }) => (
  <button
    className={cn(
      "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium",
      "transition-colors disabled:cursor-not-allowed disabled:opacity-40",
      variant === "solid" && "bg-accent text-ink hover:brightness-110",
      variant === "ghost" && "border border-line text-muted hover:border-accent hover:text-bright",
      variant === "danger" && "border border-bad/40 text-bad hover:bg-bad/10",
      className,
    )}
    {...props}
  />
);

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input
    className={cn(
      "w-full rounded-lg border border-line bg-ink/60 px-3 py-2 text-sm text-bright",
      "placeholder:text-muted/60 focus:border-accent focus:outline-none",
      className,
    )}
    {...props}
  />
);

export const Textarea = ({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea
    className={cn(
      "w-full resize-y rounded-lg border border-line bg-ink/60 px-3 py-2 text-sm text-bright",
      "placeholder:text-muted/60 focus:border-accent focus:outline-none",
      className,
    )}
    {...props}
  />
);

const STATUS_TONE: Record<string, string> = {
  succeeded: "text-ok border-ok/40 bg-ok/10",
  completed: "text-ok border-ok/40 bg-ok/10",
  approve: "text-ok border-ok/40 bg-ok/10",
  success: "text-ok border-ok/40 bg-ok/10",
  review: "text-ok border-ok/40 bg-ok/10",
  merged: "text-ok border-ok/40 bg-ok/10",
  running: "text-accent border-accent/40 bg-accent/10",
  claimed: "text-accent border-accent/40 bg-accent/10",
  planning: "text-accent border-accent/40 bg-accent/10",
  assigned: "text-accent border-accent/40 bg-accent/10",
  queued: "text-muted border-line bg-raised/40",
  pending: "text-muted border-line bg-raised/40",
  cancelled: "text-warn border-warn/40 bg-warn/10",
  blocked: "text-warn border-warn/40 bg-warn/10",
  request_changes: "text-warn border-warn/40 bg-warn/10",
  completed_with_failures: "text-warn border-warn/40 bg-warn/10",
  failed: "text-bad border-bad/40 bg-bad/10",
  failure: "text-bad border-bad/40 bg-bad/10",
};

export const Badge = ({ status, className }: { status: string; className?: string }) => (
  <span className={cn(
    "inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-xs font-medium",
    STATUS_TONE[status] ?? "text-muted border-line bg-raised/40",
    className,
  )}>
    {status.replace(/_/g, " ")}
  </span>
);

const ROLE_TONE: Record<string, string> = {
  captain: "text-accent bg-accent/10 border-accent/30",
  master: "text-accent bg-accent/10 border-accent/30",
  frontend: "text-sky-300 bg-sky-400/10 border-sky-400/30",
  backend: "text-violet-300 bg-violet-400/10 border-violet-400/30",
  database: "text-amber-300 bg-amber-400/10 border-amber-400/30",
  testing: "text-emerald-300 bg-emerald-400/10 border-emerald-400/30",
  infra: "text-orange-300 bg-orange-400/10 border-orange-400/30",
  docs: "text-pink-300 bg-pink-400/10 border-pink-400/30",
  research: "text-teal-300 bg-teal-400/10 border-teal-400/30",
  review: "text-fuchsia-300 bg-fuchsia-400/10 border-fuchsia-400/30",
  generalist: "text-slate-300 bg-slate-400/10 border-slate-400/30",
};

export const RoleChip = ({ role, className }: { role: string; className?: string }) => (
  <span className={cn(
    "shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium",
    ROLE_TONE[role] ?? ROLE_TONE.generalist, className,
  )}>
    {role}
  </span>
);

export const Spinner = ({ className }: { className?: string }) => (
  <span className={cn(
    "inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent",
    className,
  )} />
);

export const LiveDot = ({ connected }: { connected: boolean }) => (
  <span className="flex items-center gap-1.5 text-xs text-muted">
    <span className={cn("size-1.5 rounded-full", connected ? "bg-ok" : "bg-bad")} />
    {connected ? "live" : "reconnecting"}
  </span>
);

export const Field = (
  { label, hint, children }: { label: string; hint?: string; children: ReactNode },
) => (
  <label className="block">
    <span className="text-sm font-medium">{label}</span>
    {hint && <span className="ml-2 text-xs text-muted">{hint}</span>}
    <div className="mt-1.5">{children}</div>
  </label>
);

export const ErrorNote = ({ children }: { children: ReactNode }) => (
  <p className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{children}</p>
);

export const Empty = ({ children }: { children: ReactNode }) => (
  <Card className="p-6 text-center text-sm text-muted">{children}</Card>
);

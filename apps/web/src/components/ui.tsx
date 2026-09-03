import type {
  ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, HTMLAttributes,
} from "react";
import { cn } from "~/lib/cn.ts";

export const Card = ({ className, children, ...props }:
  HTMLAttributes<HTMLDivElement> & { children: ReactNode }) => (
  <div className={cn("rounded-xl border border-line/60 bg-surface/70 backdrop-blur", className)} {...props}>
    {children}
  </div>
);

export const Button = ({ className, variant = "solid", ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "solid" | "ghost" }) => (
  <button
    className={cn(
      "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium",
      "transition-colors disabled:cursor-not-allowed disabled:opacity-40",
      variant === "solid"
        ? "bg-accent text-ink hover:brightness-110"
        : "border border-line text-muted hover:border-accent hover:text-bright",
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
  review: "text-ok border-ok/40 bg-ok/10",
  merged: "text-ok border-ok/40 bg-ok/10",
  completed: "text-ok border-ok/40 bg-ok/10",
  running: "text-accent border-accent/40 bg-accent/10",
  planning: "text-accent border-accent/40 bg-accent/10",
  assigned: "text-accent border-accent/40 bg-accent/10",
  blocked: "text-warn border-warn/40 bg-warn/10",
  completed_with_failures: "text-warn border-warn/40 bg-warn/10",
  failed: "text-bad border-bad/40 bg-bad/10",
  pending: "text-muted border-line bg-raised/40",
};

export const Badge = ({ status, className }: { status: string; className?: string }) => (
  <span className={cn(
    "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
    STATUS_TONE[status] ?? "text-muted border-line bg-raised/40",
    className,
  )}>
    {status.replace(/_/g, " ")}
  </span>
);

export const ROLE_TONE: Record<string, string> = {
  frontend: "text-sky-300 bg-sky-400/10 border-sky-400/30",
  backend: "text-violet-300 bg-violet-400/10 border-violet-400/30",
  database: "text-amber-300 bg-amber-400/10 border-amber-400/30",
  testing: "text-emerald-300 bg-emerald-400/10 border-emerald-400/30",
  infra: "text-orange-300 bg-orange-400/10 border-orange-400/30",
  docs: "text-pink-300 bg-pink-400/10 border-pink-400/30",
  generalist: "text-slate-300 bg-slate-400/10 border-slate-400/30",
  master: "text-accent bg-accent/10 border-accent/30",
};

export const RoleChip = ({ role }: { role: string }) => (
  <span className={cn("rounded-md border px-2 py-0.5 text-xs font-medium", ROLE_TONE[role] ?? ROLE_TONE.generalist)}>
    {role}
  </span>
);

export const Spinner = ({ className }: { className?: string }) => (
  <span className={cn("inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent", className)} />
);

import type {
  ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "~/lib/cn.ts";

export const Card = ({ className, children, ...props }:
  HTMLAttributes<HTMLDivElement> & { children: ReactNode }) => (
  <div
    className={cn(
      "rounded-[var(--radius-card)] border-[1.5px] border-line bg-surface shadow-[4px_4px_0_#1c1917]",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export const Button = ({ className, variant = "solid", ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "solid" | "ghost" | "danger" }) => (
  <button
    className={cn(
      "inline-flex items-center justify-center gap-2 rounded-full border-[1.5px] border-line px-4 py-2 text-sm font-semibold",
      "transition-[transform,box-shadow,background-color] disabled:cursor-not-allowed disabled:opacity-40",
      variant === "solid" && "bg-[#bae6fd] text-bright hover:-translate-y-px hover:bg-[#7dd3fc] hover:shadow-[3px_3px_0_#1c1917]",
      variant === "ghost" && "bg-white text-muted hover:text-bright",
      variant === "danger" && "bg-white text-bad hover:bg-[#fee2e2]",
      className,
    )}
    {...props}
  />
);

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input
    className={cn(
      "w-full rounded-xl border-[1.5px] border-line bg-white px-3 py-2 text-sm text-bright",
      "placeholder:text-dim/70 focus:outline-none focus:ring-2 focus:ring-[#7dd3fc]/40",
      className,
    )}
    {...props}
  />
);

export const Textarea = ({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea
    className={cn(
      "w-full resize-y rounded-xl border-[1.5px] border-line bg-white px-3 py-2 text-sm text-bright",
      "placeholder:text-dim/70 focus:outline-none focus:ring-2 focus:ring-[#7dd3fc]/40",
      className,
    )}
    {...props}
  />
);

const STATUS_TONE: Record<string, string> = {
  succeeded: "bg-[#dcfce7] text-ok",
  completed: "bg-[#dcfce7] text-ok",
  approve: "bg-[#dcfce7] text-ok",
  success: "bg-[#dcfce7] text-ok",
  running: "bg-[#bae6fd] text-accent-ink",
  claimed: "bg-[#bae6fd] text-accent-ink",
  queued: "bg-white text-dim",
  cancelled: "bg-[#fef08a] text-warn",
  request_changes: "bg-[#fef08a] text-warn",
  failed: "bg-[#fee2e2] text-bad",
  failure: "bg-[#fee2e2] text-bad",
};

export const Badge = ({ status, className }: { status: string; className?: string }) => (
  <span className={cn(
    "inline-flex shrink-0 items-center rounded-full border-[1.5px] border-line px-2 py-0.5 text-xs font-semibold",
    STATUS_TONE[status] ?? "bg-white text-dim",
    className,
  )}>
    {status.replace(/_/g, " ")}
  </span>
);

const ROLE_TONE: Record<string, string> = {
  captain: "bg-[#bae6fd]",
  frontend: "bg-[#bae6fd]",
  backend: "bg-[#e9d5ff]",
  database: "bg-[#fef08a]",
  testing: "bg-[#dcfce7]",
  infra: "bg-[#fed7aa]",
  docs: "bg-[#fbcfe8]",
  research: "bg-[#ccfbf1]",
  review: "bg-[#f5d0fe]",
  generalist: "bg-white",
};

export const RoleChip = ({ role, className }: { role: string; className?: string }) => (
  <span className={cn(
    "shrink-0 rounded-full border-[1.5px] border-line px-2 py-0.5 text-xs font-semibold",
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
    {hint && <span className="ml-2 text-xs text-dim">{hint}</span>}
    <div className="mt-1.5">{children}</div>
  </label>
);

export const ErrorNote = ({ children }: { children: ReactNode }) => (
  <p className="rounded-xl border-[1.5px] border-line bg-[#fee2e2] px-3 py-2 text-sm text-bad">{children}</p>
);

export const Empty = ({ children }: { children: ReactNode }) => (
  <Card className="p-6 text-center text-sm text-muted">{children}</Card>
);

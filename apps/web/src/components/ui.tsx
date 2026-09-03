import type {
  ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, HTMLAttributes,
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
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "solid" | "ghost" }) => (
  <button
    className={cn(
      "inline-flex items-center justify-center gap-2 rounded-full border-[1.5px] border-line px-4 py-2 text-sm font-semibold",
      "transition-[transform,box-shadow,background-color] disabled:cursor-not-allowed disabled:opacity-40",
      variant === "solid"
        ? "bg-[#bae6fd] text-bright hover:-translate-y-px hover:bg-[#7dd3fc] hover:shadow-[3px_3px_0_#1c1917]"
        : "bg-white text-muted hover:border-line hover:text-bright",
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
  review: "bg-[#dcfce7] text-ok",
  merged: "bg-[#dcfce7] text-ok",
  completed: "bg-[#dcfce7] text-ok",
  running: "bg-[#bae6fd] text-accent-ink",
  planning: "bg-[#fef08a] text-warn",
  assigned: "bg-[#bae6fd] text-accent-ink",
  blocked: "bg-[#fef08a] text-warn",
  completed_with_failures: "bg-[#fef08a] text-warn",
  failed: "bg-[#fee2e2] text-bad",
  pending: "bg-white text-dim",
};

export const Badge = ({ status, className }: { status: string; className?: string }) => (
  <span className={cn(
    "inline-flex items-center rounded-full border-[1.5px] border-line px-2 py-0.5 text-xs font-semibold",
    STATUS_TONE[status] ?? "bg-white text-dim",
    className,
  )}>
    {status.replace(/_/g, " ")}
  </span>
);

export const ROLE_TONE: Record<string, string> = {
  frontend: "bg-[#bae6fd]",
  backend: "bg-[#e9d5ff]",
  database: "bg-[#fef08a]",
  testing: "bg-[#dcfce7]",
  infra: "bg-[#fed7aa]",
  docs: "bg-[#fbcfe8]",
  generalist: "bg-white",
  master: "bg-[#bae6fd]",
};

export const RoleChip = ({ role }: { role: string }) => (
  <span className={cn(
    "rounded-full border-[1.5px] border-line px-2 py-0.5 text-xs font-semibold",
    ROLE_TONE[role] ?? ROLE_TONE.generalist,
  )}>
    {role}
  </span>
);

export const Spinner = ({ className }: { className?: string }) => (
  <span className={cn("inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent", className)} />
);

import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

/**
 * The whole router.
 *
 * Three routes over the history API is not a routing problem, and the old
 * build's file-based router came with a generated route tree and an SSR server
 * this app has no use for - every page here is a view onto an authenticated
 * API, so there is nothing to render before the session exists.
 */
const listeners = new Set<() => void>();

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  addEventListener("popstate", cb);
  return () => {
    listeners.delete(cb);
    removeEventListener("popstate", cb);
  };
};

export function navigate(to: string): void {
  if (to === location.pathname + location.search) return;
  history.pushState(null, "", to);
  for (const cb of listeners) cb();
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname, () => "/");
}

/** `/threads/:id` against `/threads/thr_abc` -> `{ id: "thr_abc" }`, else null. */
export function match(path: string, pattern: string): Record<string, string> | null {
  const parts = path.split("/").filter(Boolean);
  const shape = pattern.split("/").filter(Boolean);
  if (parts.length !== shape.length) return null;

  const params: Record<string, string> = {};
  for (const [i, segment] of shape.entries()) {
    const actual = parts[i]!;
    if (segment.startsWith(":")) {
      try { params[segment.slice(1)] = decodeURIComponent(actual); }
      catch { return null; }
    }
    else if (segment !== actual) return null;
  }
  return params;
}

export function Link(
  { to, className, children }: { to: string; className?: string; children: ReactNode },
) {
  // Modified clicks still belong to the browser: a middle-click or cmd-click on
  // a link that only ever calls preventDefault cannot open a new tab.
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={onClick} className={className}>{children}</a>;
}

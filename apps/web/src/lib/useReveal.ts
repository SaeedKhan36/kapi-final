import { useEffect } from "react";

/**
 * Fades sections in as they arrive.
 *
 * One observer for the whole page rather than a hook per section, and each
 * element is unobserved once shown - a marketing page should not keep a
 * callback running for content the reader has already passed.
 */
export function useReveal() {
  useEffect(() => {
    const targets = document.querySelectorAll<HTMLElement>(".reveal:not(.in)");
    if (!("IntersectionObserver" in window)) {
      targets.forEach((el) => el.classList.add("in"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );

    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);
}

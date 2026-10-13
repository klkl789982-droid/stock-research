"use client";

import { useEffect, useRef, useState } from "react";

// A new version remounts the request view, clearing stale rows and aborting its
// previous request before a saved snapshot is checked again.
export function useLiveTransitionRevalidation(enabled: boolean) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const refresh = () => {
      if (!disposed && document.visibilityState === "visible" && !rootRef.current?.closest("[hidden]")) {
        setRefreshVersion((version) => version + 1);
      }
    };
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);

    // The screener stays mounted while a stock detail is open. Document
    // visibility does not change when that hidden ancestor is shown again.
    const observer = new MutationObserver(refresh);
    for (let ancestor: HTMLElement | null = rootRef.current; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ["hidden"] });
    }
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      observer.disconnect();
    };
  }, [enabled]);
  return { rootRef, refreshVersion };
}

"use client";

import { useEffect } from "react";

/** Registers the service worker so Brian can be installed on the home screen. */
export default function PwaBoot() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* installability is a bonus, not a requirement */
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  return null;
}

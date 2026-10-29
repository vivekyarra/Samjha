"use client";
// Applies the saved theme to <html data-theme>. Mount once in the (app) layout.
// Listens for the "samjha:settings" window event the Settings page dispatches after each save.
import { useEffect } from "react";

type Theme = "system" | "light" | "dark";
const KEY = "samjha.theme";

export function applyTheme(theme: Theme) {
  const el = document.documentElement;
  if (theme === "light" || theme === "dark") el.dataset.theme = theme;
  else delete el.dataset.theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {}
}

export function ThemeApplier() {
  useEffect(() => {
    try {
      const cached = localStorage.getItem(KEY) as Theme | null;
      if (cached) applyTheme(cached);
    } catch {}
    let cancelled = false;
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { theme?: Theme } | null) => {
        if (!cancelled && s?.theme) applyTheme(s.theme);
      })
      .catch(() => {});
    const onSettings = (e: Event) => {
      const theme = (e as CustomEvent<{ theme?: Theme }>).detail?.theme;
      if (theme) applyTheme(theme);
    };
    window.addEventListener("samjha:settings", onSettings);
    return () => {
      cancelled = true;
      window.removeEventListener("samjha:settings", onSettings);
    };
  }, []);
  return null;
}

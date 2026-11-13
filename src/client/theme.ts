import { useCallback, useEffect, useState } from "react";

/** "system" follows prefers-color-scheme; "light" / "dark" pin the theme on this device. */
export type ThemePref = "system" | "light" | "dark";

// Keep in sync with the inline script in index.html, which applies the saved theme before first paint.
const STORAGE_KEY = "sparks.theme";
const THEME_COLOR = { light: "#fafafa", dark: "#0f1012" } as const;

export const themeLabel = (pref: ThemePref) => ({ system: "System", light: "Light", dark: "Dark" })[pref];
const systemScheme = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

/**
 * Cycles system → the opposite of the system scheme → the same as it → system, so the first
 * press always changes what's on screen.
 */
export function nextTheme(pref: ThemePref): ThemePref {
  const sys = systemScheme();
  const other = sys === "dark" ? "light" : "dark";
  return pref === "system" ? other : pref === other ? sys : "system";
}

const isPref = (v: unknown): v is ThemePref => v === "system" || v === "light" || v === "dark";

export function loadTheme(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isPref(v) ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
  // The browser/OS chrome colour: each meta tag covers one system scheme; pinning overrides both.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = meta.media.includes("dark") ? "dark" : "light";
    meta.content = THEME_COLOR[pref === "system" ? scheme : pref];
  }
}

export function useTheme(): [ThemePref, (pref: ThemePref) => void] {
  const [pref, setPref] = useState(loadTheme);

  useEffect(() => applyTheme(pref), [pref]);

  // Follow changes made in other tabs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setPref(isPref(e.newValue) ? e.newValue : "system");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const set = useCallback((next: ThemePref) => {
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage unavailable: still apply for this session */
    }
    setPref(next);
  }, []);

  return [pref, set];
}

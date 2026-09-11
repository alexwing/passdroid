import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ThemePreference } from "../i18n";
import Api from "../api";

export interface ThemeContextValue {
  mode: ThemePreference;
  isDark: boolean;
  setMode: (mode: ThemePreference) => void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  mode: "system",
  isDark: false,
  setMode: () => {},
});

export const useTheme = () => useContext(ThemeContext);

const VALID_MODES: ThemePreference[] = ["light", "dark", "system"];

const prefersDark = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;

const resolveDark = (mode: ThemePreference): boolean => {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return prefersDark();
};

const applyTheme = (dark: boolean) => {
  if (typeof document === "undefined") return;
  if (dark) {
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.classList.remove("dark");
  }
};

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setModeState] = useState<ThemePreference>("system");
  const [isDark, setIsDark] = useState<boolean>(() => resolveDark("system"));
  const modeRef = useRef<ThemePreference>("system");

  const apply = useCallback((m: ThemePreference) => {
    const dark = resolveDark(m);
    applyTheme(dark);
    setIsDark(dark);
  }, []);

  // Bootstrap from preferences on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let chosen: ThemePreference = "system";
      try {
        const prefs = await Api.getPreferences();
        if (prefs?.theme && VALID_MODES.includes(prefs.theme as ThemePreference)) {
          chosen = prefs.theme as ThemePreference;
        }
      } catch {
        chosen = "system";
      }
      if (cancelled) return;
      modeRef.current = chosen;
      setModeState(chosen);
      apply(chosen);
    })();
    return () => { cancelled = true; };
  }, [apply]);

  // Follow OS theme changes when in "system" mode
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (modeRef.current === "system") {
        apply("system");
      }
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [apply]);

  const setMode = useCallback(
    (m: ThemePreference) => {
      modeRef.current = m;
      setModeState(m);
      apply(m);
      (async () => {
        try {
          const prefs = await Api.getPreferences();
          await Api.savePreferences({ ...prefs, theme: m });
        } catch (e) {
          console.error("Could not persist theme to preferences", e);
        }
      })();
    },
    [apply],
  );

  return (
    <ThemeContext.Provider value={{ mode, isDark, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
};

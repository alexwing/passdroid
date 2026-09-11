import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { type LanguagePreference, resolveLanguage, translate } from "../i18n";
import Api from "../api";

type SupportedLanguage = "es" | "en";

export interface LanguageContextValue {
  language: LanguagePreference;
  resolved: SupportedLanguage;
  setLanguage: (lang: LanguagePreference) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

export const LanguageContext = createContext<LanguageContextValue>({
  language: "system",
  resolved: "es",
  setLanguage: () => {},
  t: (key) => key,
});

export const useTranslation = () => useContext(LanguageContext);

const VALID: LanguagePreference[] = ["system", "es", "en"];

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<LanguagePreference>("system");
  const [resolved, setResolved] = useState<SupportedLanguage>(resolveLanguage("system"));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let chosen: LanguagePreference = "system";
      try {
        const prefs = await Api.getPreferences();
        if (prefs?.language && VALID.includes(prefs.language as LanguagePreference)) {
          chosen = prefs.language as LanguagePreference;
        }
      } catch {
        chosen = "system";
      }
      if (cancelled) return;
      setLanguageState(chosen);
      setResolved(resolveLanguage(chosen));
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = resolved;
    }
  }, [resolved]);

  const setLanguage = useCallback((lang: LanguagePreference) => {
    setLanguageState(lang);
    setResolved(resolveLanguage(lang));
    (async () => {
      try {
        const prefs = await Api.getPreferences();
        await Api.savePreferences({ ...prefs, language: lang });
      } catch (e) {
        console.error("Could not persist language to preferences", e);
      }
    })();
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(resolved, key, vars),
    [resolved],
  );

  const value = useMemo(
    () => ({ language, resolved, setLanguage, t }),
    [language, resolved, setLanguage, t],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};

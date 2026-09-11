import en from "./en";
import es from "./es";

export type LanguagePreference = "system" | "es" | "en";
export type ThemePreference = "system" | "light" | "dark";
export type TranslationKey = keyof typeof es;

type SupportedLanguage = "es" | "en";

const dictionaries: Record<SupportedLanguage, Record<string, string>> = { en, es };

export function resolveLanguage(preference: LanguagePreference): SupportedLanguage {
  if (preference === "es" || preference === "en") {
    return preference;
  }
  return navigator.language.toLowerCase().startsWith("en") ? "en" : "es";
}

export function translate(
  language: SupportedLanguage,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const raw = dictionaries[language]?.[key] ?? dictionaries.es[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{\{(\w+)\}\}/g, (_, name) =>
    name in vars ? String(vars[name]) : `{{${name}}}`,
  );
}

export function createTranslator(preference: LanguagePreference) {
  const language = resolveLanguage(preference);
  const dictionary = dictionaries[language];
  return (key: TranslationKey) => dictionary[key] ?? es[key] ?? key;
}

import en from "./en";
import es from "./es";

export type LanguagePreference = "system" | "es" | "en";
export type ThemePreference = "system" | "light" | "dark";
export type TranslationKey = keyof typeof es;

const dictionaries = { en, es };

export function resolveLanguage(preference: LanguagePreference): "es" | "en" {
  if (preference === "es" || preference === "en") {
    return preference;
  }
  return navigator.language.toLowerCase().startsWith("en") ? "en" : "es";
}

export function createTranslator(preference: LanguagePreference) {
  const language = resolveLanguage(preference);
  const dictionary = dictionaries[language];
  return (key: TranslationKey) => dictionary[key] ?? es[key] ?? key;
}


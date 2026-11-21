"use client";

import type { i18n as I18n } from "i18next";
import { useEffect, useState, useSyncExternalStore } from "react";
import { I18nextProvider } from "react-i18next";

import LoadingScreen from "@/components/common_components/LoadingScreen";

import i18n from "./i18n";
import { browserLanguageStore, DEFAULT_UI_LANGUAGE, LanguageStore, Locales, LOCALES, resolveLanguage } from "./languages";

type LanguageGateProps = {
  i18n: I18n;
  locales: Locales;
  store: LanguageStore;
  children: React.ReactNode;
};

const neverChanges = () => () => undefined;

export function LanguageGate({ i18n, locales, store, children }: LanguageGateProps) {
  const language = useSyncExternalStore(
    neverChanges,
    () => resolveLanguage(store.read(), locales),
    () => DEFAULT_UI_LANGUAGE,
  );
  const [settled, setSettled] = useState<string | null>(null);
  // Languages without a lazy bundle (en) are already in the initial i18n resources, so gating
  // on `settled` can strand them when the hydrated server snapshot differs from localStorage.
  const needsBundle = locales.has(language);

  useEffect(() => {
    const load = locales.get(language);
    if (!load) {
      if (i18n.language !== language) void i18n.changeLanguage(language);
      document.documentElement.lang = language;
      return;
    }
    let cancelled = false;
    load()
      .then((messages) => {
        if (cancelled) return undefined;
        i18n.addResourceBundle(language, "translation", messages);
        return i18n.changeLanguage(language);
      })
      .then(() => {
        if (!cancelled) document.documentElement.lang = language;
      })
      .catch((error: unknown) => console.warn(`Couldn't load the "${language}" translations`, error))
      .finally(() => {
        if (!cancelled) setSettled(language);
      });
    return () => {
      cancelled = true;
    };
  }, [i18n, language, locales]);

  return !needsBundle || language === settled ? children : <LoadingScreen />;
}

export default function I18nProvider({ children }: { children: React.ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <LanguageGate i18n={i18n} locales={LOCALES} store={browserLanguageStore}>
        {children}
      </LanguageGate>
    </I18nextProvider>
  );
}

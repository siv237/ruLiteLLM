import i18next from "i18next";
import { describe, expect, it } from "vitest";

import { registerFormats } from "../formats";
import { LOCALES, resolveLanguage, supportedLanguages, type Messages } from "../languages";
import en from "./en.json";
import ru from "./ru-RU.json";

function entries(messages: Messages, prefix = ""): readonly (readonly [string, string])[] {
  return Object.entries(messages).flatMap(([key, value]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [[fullKey, value] as const] : entries(value, fullKey);
  });
}

const markers = (value: string) => ({
  placeholders: [...value.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]).sort(),
  tags: [...value.matchAll(/<\/?[\w-]+[^>]*>/g)].map((match) => match[0]).sort(),
  references: [...value.matchAll(/\$t\(([^)]+)\)/g)].map((match) => match[1]).sort(),
});

const english = new Map(entries(en));

const russianPluralForm = (key: string): boolean =>
  (key.endsWith("_few") || key.endsWith("_many")) &&
  (english.has(key.replace(/_(few|many)$/, "_one")) || english.has(key.replace(/_(few|many)$/, "_other")));

describe("ru-RU locale", () => {
  it("only uses English keys plus Russian plural forms and keeps their placeholders, rich-text tags and $t references", () => {
    const incompatible = entries(ru).filter(([key, value]) => {
      if (value.trim() === "") return true;
      const source = english.get(key);
      if (source !== undefined) return JSON.stringify(markers(value)) !== JSON.stringify(markers(source));
      return !russianPluralForm(key);
    });
    expect(entries(ru).length).toBeGreaterThan(0);
    expect(incompatible).toEqual([]);
  });

  it("loads through the language registry, declines Russian count forms and falls back to English for missing keys", async () => {
    expect(supportedLanguages(LOCALES)).toContain("ru-RU");
    expect(resolveLanguage("ru-RU", LOCALES)).toBe("ru-RU");
    const load = LOCALES.get("ru-RU");
    if (!load) throw new Error("ru-RU is not registered in LOCALES");
    const messages = await load();
    const instance = i18next.createInstance();
    const options = {
      lng: "ru-RU",
      fallbackLng: "en",
      resources: { en: { translation: en }, "ru-RU": { translation: messages } },
      interpolation: { escapeValue: false },
    };
    await instance.init(options);
    const formatter = instance.services.formatter;
    if (!formatter) throw new Error("i18next formatter is not initialized");
    registerFormats(formatter);
    expect(instance.t("shell.sidebarAccountMenu.language.label")).toBe("Язык");
    const date = new Date("2026-11-11T04:03:02Z");
    const dateOptions: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    };
    expect(instance.t("format.date", { val: date, timeZone: "UTC" })).toBe(
      new Intl.DateTimeFormat("ru-RU", dateOptions).format(date),
    );
    expect(instance.t("vectorStores.table.files.count", { count: 1 })).toBe("1 файл");
    expect(instance.t("vectorStores.table.files.count", { count: 2 })).toBe("2 файла");
    expect(instance.t("vectorStores.table.files.count", { count: 5 })).toBe("5 файлов");
    instance.removeResourceBundle("ru-RU", "translation");
    expect(instance.t("shell.sidebarAccountMenu.logout")).toBe(en.shell.sidebarAccountMenu.logout);
  });
});

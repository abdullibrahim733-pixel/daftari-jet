/**
 * Localization shell (architecture.md phase A).
 *
 * Interface copy lives in `src/messages/*.json` with stable semantic keys. No
 * component hard-codes user-facing strings, and translated copy is never used
 * as a key.
 */

import en from '@/messages/en.json';
import sw from '@/messages/sw.json';
import { DEFAULT_LOCALE, type Locale } from './locales';

export type MessageKey = keyof typeof en;
export type Dictionary = Record<MessageKey, string>;

const dictionaries: Record<Locale, Dictionary> = {
  en: en as Dictionary,
  sw: sw as Dictionary,
};

export type MessageParams = Record<string, string | number>;

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE];
}

export function isMessageKey(locale: Locale, key: string): key is MessageKey {
  return key in dictionaries[locale];
}

export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export type Translator = (key: MessageKey, params?: MessageParams) => string;

export function createTranslator(locale: Locale): Translator {
  const dictionary = getDictionary(locale);
  return (key, params) => interpolate(dictionary[key] ?? key, params);
}

/** Human labels for language codes shown next to transcripts. */
export function languageLabel(code: string, locale: Locale): string {
  const normalized = code.toLowerCase();
  const isSwahili = normalized.startsWith('sw');
  const isEnglish = normalized.startsWith('en');
  if (isSwahili) return locale === 'sw' ? 'Kiswahili' : 'Swahili';
  if (isEnglish) return locale === 'sw' ? 'Kiingereza' : 'English';
  return code;
}

export function languageLabelKey(code: string): MessageKey | null {
  const normalized = code.toLowerCase();
  if (normalized.startsWith('sw')) return 'app.language.sw';
  if (normalized.startsWith('en')) return 'app.language.en';
  return null;
}
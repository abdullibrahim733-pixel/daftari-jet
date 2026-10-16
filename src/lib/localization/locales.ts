export const LOCALES = ['en', 'sw'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: string | null | undefined): value is Locale {
  return value === 'en' || value === 'sw';
}

/** BCP 47 tags used for date and number formatting. */
export const INTL_LOCALES: Record<Locale, string> = {
  en: 'en-TZ',
  sw: 'sw-TZ',
};

/**
 * Maps a UI locale to a speech-recognition hint. The product requires Swahili
 * and English; voice language still varies per utterance, so this is only a
 * hint sent to the speech adapter.
 */
export const SPEECH_LANGUAGE_HINTS: Record<Locale, string> = {
  en: 'en-TZ',
  sw: 'sw-TZ',
};
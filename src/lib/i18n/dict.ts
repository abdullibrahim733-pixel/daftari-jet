export const dict = {
  en: {
    app: 'Daftari',
    nav: {
      review: 'Review',
      records: 'Records',
      deni: 'Deni',
      reports: 'Reports',
      settings: 'Settings',
    },
    common: {
      loading: 'Loading...',
      error: 'Something went wrong',
      save: 'Save',
      cancel: 'Cancel',
      confirm: 'Confirm',
      reject: 'Reject',
      edit: 'Edit',
      view: 'View',
    },
  },
  sw: {
    app: 'Daftari',
    nav: {
      review: 'Kagua',
      records: 'Rekodi',
      deni: 'Deni',
      reports: 'Ripoti',
      settings: 'Mipangilio',
    },
    common: {
      loading: 'Inapakia...',
      error: 'Hitilafu imetokea',
      save: 'Hifadhi',
      cancel: 'Ghairi',
      confirm: 'Thibitisha',
      reject: 'Kataa',
      edit: 'Hariri',
      view: 'Tazama',
    },
  },
} as const;

export type Locale = keyof typeof dict;
export type Dict = (typeof dict)[Locale];

export function t(locale: Locale, path: string): string {
  const parts = path.split('.');
  let current: unknown = dict[locale];
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      current = null;
    }
  }
  if (typeof current === 'string') return current;
  // Fallback to English
  let fallback: unknown = dict.en;
  for (const part of parts) {
    if (fallback && typeof fallback === 'object' && part in fallback) {
      fallback = (fallback as Record<string, unknown>)[part];
    } else {
      fallback = null;
    }
  }
  return typeof fallback === 'string' ? fallback : path;
}

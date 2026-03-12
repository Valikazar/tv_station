import en, { Locale } from './locales/en';
import ru from './locales/ru';

const locales: Record<string, Locale> = { en, ru };

export function getLocale(lang?: string): Locale {
    return locales[lang as string] ?? en;
}

export type { Locale };

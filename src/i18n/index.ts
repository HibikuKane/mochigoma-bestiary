import type { GameEvent } from "../core/model";
import { en } from "./en";
import { ja } from "./ja";
import { ko } from "./ko";
import type { Locale, Messages } from "./types";

export type { Locale, Messages } from "./types";
export const localeNames: Record<Locale, string> = { ko: "한국어", ja: "日本語", en: "English" };
export const dictionaries: Record<Locale, Messages> = { ko, ja, en };
export const LOCALE_STORAGE_KEY = "mochigoma-bestiary.locale";

export function isLocale(value: unknown): value is Locale {
  return value === "ko" || value === "ja" || value === "en";
}

export function resolveLocale(saved: unknown, preferred: readonly string[]): Locale {
  if (isLocale(saved)) return saved;
  for (const language of preferred) {
    const base = language.toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return "en";
}

// Browsers may deny storage access; language switching must still work.
export function loadLocale(preferred: readonly string[], getStorage: () => Pick<Storage, "getItem">): Locale {
  try {
    return resolveLocale(getStorage().getItem(LOCALE_STORAGE_KEY), preferred);
  } catch {
    return resolveLocale(null, preferred);
  }
}

export function saveLocale(locale: Locale, getStorage: () => Pick<Storage, "setItem">): void {
  try { getStorage().setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Session-only preference. */ }
}

export function formatEvent(event: GameEvent, messages: Messages): string {
  switch (event.type) {
    case "start": return messages.start(messages.sides[event.player]);
    case "move": {
      const side = messages.sides[event.player];
      const piece = messages.pieces[event.piece];
      const text = event.captured
        ? messages.captured(side, piece, messages.pieces[event.captured])
        : messages.moved(side, piece);
      return event.promoted ? `${text} ${messages.promotion}` : text;
    }
    case "drop": return messages.dropped(messages.sides[event.player], messages.pieces[event.piece]);
    case "win": return messages.win(messages.sides[event.winner], messages.reasons[event.reason]);
    case "draw": return messages.draw;
  }
}

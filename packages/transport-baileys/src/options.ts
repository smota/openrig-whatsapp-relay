const WORDS = new Map<string, Map<string, number>>(Object.entries({
  en: { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 },
  pt: { um: 1, uma: 1, dois: 2, duas: 2, "três": 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9 },
  es: { uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 },
}).map(([locale, words]) => [locale, new Map(Object.entries(words))] as const));

export interface OptionReplyOptions {
  /** Locales whose number words count. Default `["en"]`. Known: en, pt, es. */
  locales?: string[];
  /** A voice transcript: a word counts only with no trailing punctuation ("One." starts a sentence). */
  voice?: boolean;
}

/**
 * Parse a reply that is nothing but an option number: "2", "2.", " 2) ", or a number word in one
 * of the given locales ("Dois."). Anything else (a number inside a sentence) returns null, so a
 * free-text reply is never mistaken for a choice.
 */
export function parseOptionReply(text: string, opts: OptionReplyOptions = {}): number | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  const bare = trimmed.replace(/[.!)\s]+$/u, "").toLowerCase();
  if (/^\d{1,2}$/.test(bare)) return Number(bare);
  const candidate = (opts.voice ? trimmed.toLowerCase() : bare).normalize("NFC");
  for (const locale of opts.locales ?? ["en"]) {
    const n = WORDS.get(locale)?.get(candidate);
    if (typeof n === "number") return n;
  }
  return null;
}

// Shared text measures for profiles that check the language of user-facing text (ui labels, docs pages).
// The measure is the share of words that are stopwords of another language and not of the repo's own.

export const STOPWORDS = Object.freeze({
  en: ['the', 'and', 'of', 'to', 'in', 'is', 'are', 'for', 'on', 'with', 'this', 'that', 'your', 'you', 'from', 'by', 'at', 'be', 'it', 'as', 'or', 'an', 'was', 'will', 'all', 'has', 'have', 'not', 'more', 'our', 'we', 'can', 'these', 'its', 'here'],
  es: ['a', 'le', 'les', 'si', 'el', 'la', 'los', 'las', 'de', 'del', 'y', 'en', 'que', 'para', 'con', 'por', 'un', 'una', 'es', 'son', 'se', 'al', 'lo', 'como', 'más', 'este', 'esta', 'estos', 'sus', 'su', 'o', 'sin', 'sobre', 'pero', 'hay', 'ya', 'no'],
  pt: ['o', 'a', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'e', 'em', 'no', 'na', 'que', 'para', 'com', 'por', 'um', 'uma', 'é', 'são', 'se', 'ao', 'como', 'mais', 'este', 'esta', 'seu', 'sua', 'não', 'sem'],
  fr: ['le', 'la', 'les', 'de', 'des', 'du', 'et', 'en', 'que', 'pour', 'avec', 'par', 'un', 'une', 'est', 'sont', 'se', 'au', 'aux', 'ce', 'cette', 'ces', 'son', 'sa', 'ses', 'ne', 'pas', 'plus', 'dans', 'sur', 'il', 'elle'],
  de: ['der', 'die', 'das', 'und', 'in', 'zu', 'den', 'von', 'mit', 'für', 'ist', 'sind', 'ein', 'eine', 'nicht', 'auf', 'auch', 'es', 'dem', 'des', 'sich', 'im', 'oder', 'wie', 'bei'],
  it: ['il', 'lo', 'la', 'i', 'gli', 'le', 'di', 'del', 'della', 'e', 'in', 'che', 'per', 'con', 'un', 'una', 'è', 'sono', 'si', 'al', 'come', 'più', 'questo', 'questa', 'non', 'nel', 'sul'],
});

const MAX_UNIT_LENGTH = 4;

function cleanToken(token) {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** Words of a text, excluding numbers and the short unit that follows a number. */
export function wordsOf(text) {
  const words = [];
  let previousNumeric = false;
  for (const raw of String(text).split(/\s+/)) {
    const token = cleanToken(raw);
    if (token === '') {
      // A bare symbol after a number ("12 %") is that number's unit.
      if (raw !== '' && previousNumeric) previousNumeric = false;
      continue;
    }
    const numeric = /\d/.test(token);
    const isUnit = previousNumeric && !numeric && token.length <= MAX_UNIT_LENGTH;
    if (!numeric && !isUnit && /\p{L}/u.test(token)) words.push(token.toLowerCase());
    previousNumeric = numeric;
  }
  return words;
}

/** The primary language subtag of a locale ("fr-FR" -> "fr"), or null when the locale is unset. */
export function primaryLanguage(locale) {
  return typeof locale === 'string' && locale.trim() !== '' ? locale.trim().toLowerCase().split(/[-_]/)[0] : null;
}

export function foreignStopwordShare(words, locale) {
  const own = new Set(STOPWORDS[primaryLanguage(locale)] ?? []);
  const others = new Set(Object.entries(STOPWORDS).filter(([language]) => language !== primaryLanguage(locale)).flatMap(([, list]) => list));
  const foreign = words.filter((word) => others.has(word) && !own.has(word));
  return { foreign: foreign.length, words: words.length, share: words.length === 0 ? 0 : foreign.length / words.length };
}

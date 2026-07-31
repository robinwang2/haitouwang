const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
}

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms: string[] = [];

  for (const word of words) {
    terms.push(word);
    if (!CJK_CHARACTER.test(word)) continue;

    const characters = [...word];
    terms.push(...characters);
    for (let index = 0; index < characters.length - 1; index += 1) {
      terms.push(`${characters[index]}${characters[index + 1]}`);
    }
  }

  return [...new Set(terms)];
}

export function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

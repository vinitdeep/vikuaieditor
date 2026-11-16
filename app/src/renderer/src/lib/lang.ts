import type { Lang, LangOpt } from '@/api/types'

export const LANGS: { id: Lang; label: string; native: string; short: string }[] = [
  { id: 'or', label: 'Odia', native: 'ଓଡ଼ିଆ', short: 'OR' },
  { id: 'hi', label: 'Hindi', native: 'हिन्दी', short: 'HI' },
  { id: 'en', label: 'English', native: 'English', short: 'EN' }
]

export const langLabel = (l: LangOpt): string => (l === 'auto' ? 'Auto' : (LANGS.find((x) => x.id === l)?.label ?? l))
export const langShort = (l: LangOpt): string => (l === 'auto' ? 'AUTO' : (LANGS.find((x) => x.id === l)?.short ?? l))

/** CSS font stack for script text (bundled Noto fonts, never Nirmala UI). */
export function scriptFont(l: LangOpt | undefined): string {
  if (l === 'or') return "'Noto Sans Oriya', 'Inter', sans-serif"
  if (l === 'hi') return "'Noto Sans Devanagari', 'Inter', sans-serif"
  return "'Inter', 'Noto Sans Oriya', 'Noto Sans Devanagari', sans-serif"
}

/** guess script of a string (for mixed transcripts) */
export function detectLang(text: string): Lang {
  if (/[଀-୿]/.test(text)) return 'or'
  if (/[ऀ-ॿ]/.test(text)) return 'hi'
  return 'en'
}

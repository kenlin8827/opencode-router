/**
 * caveman output-style prompts (project-original wording): injected into the
 * system message to steer the model toward fewer output tokens for the same
 * information. Six intensity levels.
 *
 * Shared constraints (carried by every level):
 *  - code, paths, commands, URLs, error messages stay verbatim;
 *  - security warnings / destructive-action confirmations / ordered steps
 *    temporarily revert to full sentences, brevity resumes afterwards;
 *  - the style never names or explains itself;
 *  - the user's dominant language is preserved (except wenyan levels).
 */

export const CAVEMAN_LEVELS = ['lite', 'full', 'ultra', 'wenyan-lite', 'wenyan', 'wenyan-ultra'] as const;
export type CavemanLevel = (typeof CAVEMAN_LEVELS)[number];

const KEEP_EXACT =
  'Code blocks, file paths, shell commands, URLs, and error messages must stay character-for-character exact.';

const FULL_SENTENCE_EXCEPTIONS =
  'When giving security warnings, confirming destructive or irreversible actions, or listing ordered multi-step procedures, temporarily switch back to normal complete sentences; resume brevity once past that part.';

const NO_META =
  'Never mention or name this response style, never apologize for being brief, and never invent abbreviations — standard acronyms (API, DB, URL, JSON) are fine, and identifiers or error strings stay verbatim.';

const KEEP_LANGUAGE =
  'Answer in the user\'s dominant language. Technical identifiers keep their original form regardless of language.';

export const CAVEMAN_PROMPTS: Record<CavemanLevel, string> = {
  lite: [
    'Answer concisely. Use complete, grammatical sentences, but cut filler words, hedging, and social phrases (no "sure", "of course", "I\'d be happy to").',
    'Structure: conclusion first, then the reason, then the next step.',
    KEEP_EXACT,
    FULL_SENTENCE_EXCEPTIONS,
    NO_META,
    KEEP_LANGUAGE,
  ].join(' '),

  full: [
    'Be extremely terse. Sentence fragments are acceptable. Omit articles, filler, hedging, and greetings where meaning stays clear.',
    'Structure: what it is — what to do — why — what next, in as few words as possible.',
    KEEP_EXACT,
    FULL_SENTENCE_EXCEPTIONS,
    NO_META,
    KEEP_LANGUAGE,
  ].join(' '),

  ultra: [
    'Use the fewest words possible. Telegraphic fragments; drop conjunctions and articles whenever the meaning survives.',
    'One precise word beats two vague ones. No preamble, no recap.',
    KEEP_EXACT,
    FULL_SENTENCE_EXCEPTIONS,
    NO_META,
    KEEP_LANGUAGE,
  ].join(' '),

  'wenyan-lite': [
    '以简练半文言作答：保留现代语法骨架，删去虚词、客套与冗余修饰。技术术语、代码、路径保持原文。',
    KEEP_EXACT,
    FULL_SENTENCE_EXCEPTIONS,
    NO_META,
  ].join(' '),

  wenyan: [
    '以文言文作答，务求简峻：主语可省则省，虚词可用可不用则不用，动词居前，单音词优先。',
    '代码、命令、路径、报错信息保留原文，不可改写翻译。',
    KEEP_EXACT,
    FULL_SENTENCE_EXCEPTIONS,
    NO_META,
  ].join(' '),

  'wenyan-ultra': [
    '以极简文言作答：一字不多言，词约而义足。代码、路径、命令、报错保持原文。',
    KEEP_EXACT,
    FULL_SENTENCE_EXCEPTIONS,
    NO_META,
  ].join(' '),
};

export function isCavemanLevel(level: unknown): level is CavemanLevel {
  return typeof level === 'string' && (CAVEMAN_LEVELS as readonly string[]).includes(level);
}

import { invalid } from '../llm/structured.js';
import { TECH } from '../jobs/parser.js';

const TECH_NAMES = new Set(TECH.map((name) => name.toLowerCase()));

// The fabrication guard. Generated application text may rephrase and
// re-order what the owner has supplied, but it may not introduce facts:
// every number and every proper-noun, acronym or technology token in it must
// appear in the allowed corpus (the owner's resume, approved facts and
// projects, and, where stated, the job listing itself). A violation is
// rejected, never repaired, so the model is asked again with the problem.

const NUMBER = /\$?\d[\d,]*(?:\.\d+)?(?:\+|[kKmMbB]\b|%)?/g;
// Capitalised words, acronyms, camelCase and tech names (C++, Node.js, iOS).
const PROPER = /\b(?:[A-Z][A-Za-z0-9]*(?:[+#]+|\.[A-Za-z]{1,3})?|[a-z]+[A-Z][A-Za-z0-9]*)\b/g;
const COMMON_CAPS = new Set(['i', 'i\'m', 'i\'ve', 'i\'d', 'i\'ll', 'a', 'an', 'the', 'and', 'but', 'my', 'we', 'it', 'at', 'in', 'on', 'for', 'with', 'as', 'to', 'from', 'of', 'if', 'this', 'that', 'these', 'those', 'dear', 'hi', 'hello', 'best', 'regards', 'thanks', 'thank', 'sincerely', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'hn', 'hacker', 'news', 'github', 'linkedin', 'email', 'cv', 'pdf', 'ceo', 'cto', 'vp', 'ai', 'api', 'apis', 'sdk', 'sdks', 'ui', 'ux', 'ci', 'cd', 'ok']);

const normNumber = (token) => token.replace(/[$,]/g, '').replace(/\.$/, '').toLowerCase();
const words = (text) => new Set(String(text).toLowerCase().match(/[a-z0-9][a-z0-9+#.'-]*[a-z0-9+#]|[a-z0-9]/g) ?? []);

export function buildCorpus(...texts) {
  const joined = texts.filter(Boolean).join('\n');
  const numbers = new Set((joined.match(NUMBER) ?? []).map(normNumber));
  return { words: words(joined), numbers, text: joined.toLowerCase() };
}

/** Proper-noun-like tokens that are not simply capitalised because they start a sentence. */
function claimTokens(text) {
  const tokens = [];
  const sentences = String(text).split(/(?<=[.!?:;\n])\s+|\n+/);
  for (const sentence of sentences) {
    const matches = [...sentence.matchAll(PROPER)];
    for (const [index, match] of matches.entries()) {
      const atStart = match.index === 0 || /^[\s"'(\-•*]*$/.test(sentence.slice(0, match.index));
      if (atStart && index === 0 && !/[A-Z].*[A-Z]|[+#]/.test(match[0])) continue; // ordinary capitalised first word
      tokens.push(match[0]);
    }
  }
  return tokens;
}

/** The unsupported numbers and tokens in `text` against the allowed corpora. */
export function unsupportedClaims(text, ...corpora) {
  return findUnsupported(text, corpora, false);
}

/** Headlines are Title Case, so plain capitalised words are not evidence of a claim there; technologies, acronyms, numbers and links still are. */
export function unsupportedHeadlineClaims(text, ...corpora) {
  return findUnsupported(text, corpora, true);
}

function findUnsupported(text, corpora, titleCase) {
  const bad = new Set();
  for (const match of String(text).match(NUMBER) ?? []) {
    const value = normNumber(match);
    if (!corpora.some((corpus) => corpus.numbers.has(value))) bad.add(match);
  }
  // Addresses and links must come from the supplied material, never from the model.
  for (const match of String(text).match(/https?:\/\/[^\s)]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) {
    if (!corpora.some((corpus) => corpus.text.includes(match.toLowerCase().replace(/[.,;]+$/, '')))) bad.add(match);
  }
  for (const token of claimTokens(text)) {
    const lowered = token.toLowerCase().replace(/'s$/, '');
    if (COMMON_CAPS.has(lowered)) continue;
    // Plain Title-Case words only matter in a headline when they name a technology.
    if (titleCase && !TECH_NAMES.has(lowered) && !/[A-Z].*[A-Z]|[0-9+#]/.test(token)) continue;
    if (!corpora.some((corpus) => corpus.words.has(lowered) || corpus.text.includes(lowered))) bad.add(token);
  }
  return [...bad];
}

/** Throws INVALID_OUTPUT (so the model is asked again) when `text` claims anything unsupported. */
export function assertSupported(label, text, ...corpora) {
  return assertWith(unsupportedClaims, label, text, corpora);
}

export function assertHeadlineSupported(label, text, ...corpora) {
  return assertWith(unsupportedHeadlineClaims, label, text, corpora);
}

function assertWith(find, label, text, corpora) {
  const bad = find(text, ...corpora);
  if (bad.length) throw invalid(`${label} mentions ${bad.slice(0, 6).map((token) => `"${token}"`).join(', ')}, which is not in the candidate's supplied facts. Use only supplied facts`);
}

export const STOCK_PHRASES = [/\bi am (?:very |so |truly )?excited to apply\b/i, /\bi(?:'m| am) writing to (?:apply|express)/i, /\bi believe (?:that )?my skills (?:make|would make) me\b/i, /\bgreat fit\b/i, /\bpassionate about\b/i, /\bto whom it may concern\b/i, /\bhope this (?:email|message) finds you\b/i];

// Claims about career chronology or superlatives the guard cannot verify token by token.
export const UNVERIFIABLE_PHRASES = [/\b(?:started|began|launched|kicked off) my career\b/i, /\bmy first (?:job|role|position)\b/i, /\bearly in my career\b/i, /\bi(?:'ve| have) (?:always|never)\b/i, /\b(?:the )?(?:best|top|leading) (?:engineer|developer)\b/i];

export function assertNoUnverifiablePhrases(label, text) {
  const hit = UNVERIFIABLE_PHRASES.find((pattern) => pattern.test(text));
  if (hit) throw invalid(`${label} says "${text.match(hit)[0]}", a claim about career order or superlatives that the supplied facts do not state; remove it`);
}

export function assertNoStockPhrases(label, text) {
  const hit = STOCK_PHRASES.find((pattern) => pattern.test(text));
  if (hit) throw invalid(`${label} uses a stock phrase ("${text.match(hit)[0]}"); open with something specific to the company instead`);
}

export const wordCount = (text) => (String(text).trim().match(/\S+/g) ?? []).length;

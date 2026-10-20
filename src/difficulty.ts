/**
 * Per-request difficulty estimate. v0 is a transparent heuristic (no model call, zero marginal
 * cost); every contribution is reported in `signals` so rankings stay auditable. Phase 1 A/B
 * data is meant to replace these hand-set weights with fitted ones.
 */
export type Domain = 'coding' | 'general';

export type RequestProfile = {
  /** 0 (trivial) .. 1 (hardest). */
  difficulty: number;
  domain: Domain;
  /** Whole prompt, as sent to the router. */
  promptTokens: number;
  /** Predicted completion tokens (incl. reasoning), capped by max_tokens. */
  outputTokens: number;
  signals: string[];
};

const CODE_RE = /```|\b(function|class|def|import|const|stack ?trace|traceback|exception|compile|refactor|typescript|javascript|python|rust|golang|sql|regex|bug|debug)\b/i;
const REASONING_RE = /\b(prove|proof|derive|step[- ]by[- ]step|optimi[sz]e|trade-?offs?|architecture|design|analy[sz]e|why|root cause|edge cases?)\b/i;
const MATH_RE = /\\frac|\\int|\\sum|\b(integral|derivative|theorem|lemma|probability|equation)\b/i;
const EASY_RE = /\b(summari[sz]e|translate|rephrase|rewrite|typo|hello|thanks|what is|define)\b/i;

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('\n');
  }
  return '';
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';

export function analyzeRequest(request: Record<string, unknown>): RequestProfile {
  const messages = Array.isArray(request.messages) ? request.messages.filter(isObject) : [];
  const texts = messages.map(message => textOf(message.content));
  const lastUser = [...messages].reverse().find(message => message.role === 'user');
  const ask = lastUser ? textOf(lastUser.content) : (texts.at(-1) ?? '');
  const askTokens = estimateTokens(ask);

  const signals: string[] = [];
  let difficulty = 0.25;
  const add = (condition: boolean, delta: number, label: string): void => {
    if (!condition) return;
    difficulty += delta;
    signals.push(`${label}${delta >= 0 ? '+' : ''}${delta}`);
  };

  const isCode = CODE_RE.test(ask);
  add(isCode, 0.15, 'coding');
  add(REASONING_RE.test(ask), 0.15, 'reasoning');
  add(MATH_RE.test(ask), 0.15, 'math');
  add(Array.isArray(request.tools) && request.tools.length > 0, 0.1, 'tools');
  add(askTokens > 400, 0.1, 'long-ask');
  add(askTokens > 2000, 0.1, 'very-long-ask');
  add(EASY_RE.test(ask) && askTokens < 400 && !isCode, -0.15, 'easy-cue');
  add(askTokens < 20 && !isCode, -0.1, 'short-ask');

  const clamped = Math.min(0.95, Math.max(0.05, difficulty));
  const promptTokens = estimateTokens(texts.join('\n')) + 4 * messages.length;
  const capRaw = request.max_completion_tokens ?? request.max_tokens;
  const cap = typeof capRaw === 'number' && capRaw > 0 ? capRaw : Infinity;
  const outputTokens = Math.min(Math.round(150 + 1850 * clamped), cap);

  return {
    difficulty: Math.round(clamped * 1000) / 1000,
    domain: isCode ? 'coding' : 'general',
    promptTokens,
    outputTokens,
    signals,
  };
}

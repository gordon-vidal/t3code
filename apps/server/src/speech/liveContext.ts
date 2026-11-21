import type {
  OrchestrationV2Checkpoint,
  OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";

export interface TranscriptionLiveContext {
  readonly projectTitle?: string | undefined;
  readonly threadTitle?: string | undefined;
  readonly branch?: string | undefined;
  readonly files: ReadonlyArray<string>;
  readonly terms: ReadonlyArray<string>;
}

export const SPEECH_CONTEXT_MESSAGE_LIMIT = 15;
export const SPEECH_CONTEXT_CHECKPOINT_LIMIT = 10;

const MAX_FILES = 25;
const MAX_TERMS = 45;
const MAX_TERM_LENGTH = 80;
const MIN_TERM_LENGTH = 2;
const MAX_TERM_SPACES = 3;
const MAX_MESSAGE_CHARS = 4_000;

const INLINE_BACKTICK_RE = /`([^`\r\n]{2,80})`/g;
const FILE_PATH_RE =
  /(?:^|[\s([{"'])((?:[a-zA-Z0-9_@.-]+\/)+[a-zA-Z0-9_.-]+(?:\.[a-zA-Z0-9]{1,10})?|[a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|swift|kt|css|scss|html|sql|sh|yaml|yml|toml))(?=$|[\s)\]}"',:;!?])/g;
const CODE_IDENTIFIER_RE =
  /\b(?:[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*|[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*|[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)\b/g;

function normalizeTerm(raw: string): string | null {
  const trimmed = raw.trim().replace(/^[([{"']+|[)\]}"',:;!?]+$/g, "");
  if (trimmed.length < MIN_TERM_LENGTH || trimmed.length > MAX_TERM_LENGTH) return null;
  if (/^\d+$/.test(trimmed)) return null;
  if (/[<>]/.test(trimmed)) return null;
  // Reject prose sentences inside backticks while keeping short CLI commands like `vp run check:changed`.
  if ((trimmed.match(/\s+/g)?.length ?? 0) > MAX_TERM_SPACES) return null;
  return trimmed;
}

/**
 * Extracts deduplicated technical terms (inline code, file paths, code identifiers)
 * from recent thread messages, ordered most-recent-first and capped at `maxTerms`.
 */
export function extractThreadTerms(
  messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "role" | "text">>,
  maxTerms = MAX_TERMS,
): ReadonlyArray<string> {
  const recent = messages
    .filter((message) => message.role !== "system" && message.text.trim().length > 0)
    .slice(-SPEECH_CONTEXT_MESSAGE_LIMIT);

  const seen = new Set<string>();
  const terms: string[] = [];

  const push = (raw: string) => {
    if (terms.length >= maxTerms) return;
    const term = normalizeTerm(raw);
    if (!term) return;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(term);
  };

  // Walk newest-to-oldest so the most recent terminology wins the cap.
  for (let i = recent.length - 1; i >= 0 && terms.length < maxTerms; i -= 1) {
    const rawText = recent[i]!.text;
    const text = rawText.length > MAX_MESSAGE_CHARS ? rawText.slice(-MAX_MESSAGE_CHARS) : rawText;
    for (const match of text.matchAll(INLINE_BACKTICK_RE)) {
      if (match[1]) push(match[1]);
    }
    for (const match of text.matchAll(FILE_PATH_RE)) {
      if (match[1]) push(match[1]);
    }
    for (const match of text.matchAll(CODE_IDENTIFIER_RE)) {
      if (match[0]) push(match[0]);
    }
  }

  return terms;
}

/**
 * Extracts deduplicated file paths from recent thread checkpoints, newest-first.
 */
export function extractCheckpointFiles(
  checkpoints: ReadonlyArray<Pick<OrchestrationV2Checkpoint, "files">>,
  maxFiles = MAX_FILES,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const files: string[] = [];

  for (let i = checkpoints.length - 1; i >= 0 && files.length < maxFiles; i -= 1) {
    for (const file of checkpoints[i]!.files) {
      if (files.length >= maxFiles) break;
      const path = file.path.trim();
      if (!path) continue;
      const key = path.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(path);
    }
  }

  return files;
}

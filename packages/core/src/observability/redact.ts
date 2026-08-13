/**
 * Secret redaction (spec §37: "Sensitive values must be redacted").
 *
 * Design stance: redaction is applied at the LOGGER, not at call sites. Relying
 * on every future author to remember to scrub a field is how credentials end up
 * in log files. The logger scrubs everything on the way out, so forgetting is
 * not possible.
 *
 * Two complementary passes:
 *   1. Key-name matching — any object key that looks like a secret has its
 *      value replaced, whatever the value is.
 *   2. Value pattern matching — catches secrets that arrive inside free text,
 *      such as an API key embedded in an error message.
 */

export const REDACTED = '[REDACTED]';

/** Substrings that mark a key as sensitive. Matched case-insensitively. */
const SENSITIVE_KEY_PARTS = [
  'apikey',
  'api_key',
  'password',
  'passwd',
  'secret',
  'token',
  'credential',
  'authorization',
  'auth',
  'cookie',
  'session',
  'privatekey',
  'private_key',
  'refresh',
  'bearer',
  'passphrase',
  'pin',
  'otp',
] as const;

/**
 * Keys whose *content* is private user data rather than a credential.
 * Spec §37 forbids logging private messages; we keep the key visible so the
 * shape of the call is still debuggable, but drop the content.
 */
const PRIVATE_CONTENT_KEYS = ['message', 'messagetext', 'transcript', 'clipboard', 'body'] as const;

const VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  // Anthropic
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  // OpenAI and similar `sk-` keys
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // GitHub tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // AWS access key IDs
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Bearer headers
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  // JWTs
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Anything shaped like `key=value` where key looks sensitive
  /\b(?:api[_-]?key|token|password|secret)\s*[=:]\s*"?[^\s"',]{6,}"?/gi,
];

function keyIsSensitive(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z_]/g, '');
  return SENSITIVE_KEY_PARTS.some((part) => k.includes(part.replace(/_/g, '')));
}

function keyIsPrivateContent(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z]/g, '');
  return PRIVATE_CONTENT_KEYS.some((part) => k === part.replace(/_/g, ''));
}

export function redactString(input: string): string {
  let out = input;
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Longest string retained in a log field before truncation. */
const MAX_STRING_LENGTH = 2000;
/** Deepest object nesting walked; anything deeper is elided. */
const MAX_DEPTH = 8;
/** Most array elements retained. */
const MAX_ARRAY_LENGTH = 100;

/**
 * Recursively redact a value for logging. Also bounds size, because an
 * unbounded structure in a log line is its own kind of failure (spec §37 wants
 * logs to stay *useful*).
 *
 * Cycles are handled via a seen-set rather than throwing, since tool inputs may
 * legitimately contain shared references.
 */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const scrubbed = redactString(value);
    return scrubbed.length > MAX_STRING_LENGTH
      ? `${scrubbed.slice(0, MAX_STRING_LENGTH)}…[+${scrubbed.length - MAX_STRING_LENGTH} chars]`
      : scrubbed;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return typeof value === 'bigint' ? value.toString() : value;
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return `[${typeof value}]`;
  }

  if (depth >= MAX_DEPTH) return '[depth-limit]';

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      // Stacks can contain argument values on some runtimes; scrub them too.
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (value instanceof Date) return value.toISOString();

  // Buffers/typed arrays: never log contents, only size.
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `[binary ${value.byteLength} bytes]`;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_LENGTH).map((v) => redact(v, depth + 1, seen));
      if (value.length > MAX_ARRAY_LENGTH) items.push(`[+${value.length - MAX_ARRAY_LENGTH} more]`);
      return items;
    }

    if (value instanceof Map) {
      return redact(Object.fromEntries(value), depth + 1, seen);
    }
    if (value instanceof Set) {
      return redact([...value], depth + 1, seen);
    }

    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (keyIsSensitive(key)) {
        out[key] = REDACTED;
      } else if (keyIsPrivateContent(key)) {
        out[key] =
          typeof v === 'string' ? `[${v.length} chars withheld]` : '[content withheld]';
      } else {
        out[key] = redact(v, depth + 1, seen);
      }
    }
    return out;
  }

  return '[unserialisable]';
}

/** Redact a fields bag, guaranteeing an object result. */
export function redactFields(
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  return redact(fields) as Record<string, unknown>;
}

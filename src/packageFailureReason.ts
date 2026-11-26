/**
 * Structured failure reason for the packaging failure callback (issue #63).
 *
 * WHY THIS EXISTS
 * ---------------
 * `CallbackListener.onPackageFail(message, err)` used to POST `{ message }` and
 * drop `err` entirely, so the consumer had nothing to branch on but prose and
 * had to infer the failure class by matching text — or, when nothing arrived at
 * all, wait out its 15-minute completion watchdog. This module turns the error
 * that was being dropped into one short, stable token naming the failure CLASS,
 * which the consumer maps straight onto a structured error code.
 *
 * CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
 * -----------------------------------------------------------
 *   - The callback body this token travels in: POST
 *     `<callback>/packagerCallback/failure`, request schema
 *     `{ message: string (required), reason?: string }`,
 *     `additionalProperties: false` — consumer `openapi.json`, path
 *     `/api/v1/internal/packagerCallback/failure`, and the Zod source of that
 *     schema, `packagerFailureSchema` (Eyevinn/open-videocore
 *     `src/routes/internal.ts:121-124`). Nothing beyond `message` and `reason`
 *     may be added to the body: the schema forbids extra properties.
 *   - The token vocabulary: `PACKAGE_FAILURE_REASONS` =
 *     `['unsupported_media', 'invalid_credentials', 'packaging_failed']` and
 *     `normalisePackageFailureReason` / `classifyPackageFailure` in
 *     Eyevinn/open-videocore `src/pipeline/package-failure-detail.ts`. The
 *     consumer lower-cases and trims, rejects anything outside the set, and
 *     treats `packaging_failed` as "fall through to text matching", which is
 *     why this module can safely send it as the default.
 *   - The error texts classified here, read in this repo:
 *       * `EncorePackager.package` wraps every packaging failure as
 *         `Packaging of job <id> failed: <underlying message>`
 *         (`src/encorePackager.ts:117-126`), so the underlying tool's wording
 *         is what reaches us, nested in that sentence.
 *       * `EncorePackager.getEncoreJob` throws
 *         `Failed to fetch job from Encore, got status: <status>`
 *         (`src/encorePackager.ts:235-239`) — the 401 case is a rejected
 *         credential.
 *       * `@osaas/client-core` (installed 0.8.x) exports `TokenExpiredError`
 *         (`'Service Access Token expired'`) and `UnauthorizedError`
 *         (`'Unauthorized'`) from `lib/errors.js`, and `FetchError` with an
 *         `httpCode` member from `lib/fetch.js`; `Context` itself throws
 *         `'Personal access token is required to create a context. ...'`
 *         (`lib/context.js:10`). `Context.getServiceAccessToken` is on the
 *         packaging path (`src/encorePackager.ts:86-92`), so these are the
 *         credential errors actually observed.
 *       * `RedisListener.handleMessage` re-wraps a redacted error as
 *         `new Error(detail)` before the listener sees it
 *         (`src/redisListener.ts:175-181`), i.e. the class is often gone by
 *         then and only the text survives — hence text matching, not just
 *         `instanceof`.
 *
 * NOTHING FROM THE ERROR IS COPIED INTO THE TOKEN. The error is only ever
 * MATCHED against here. The returned value is one of three compile-time
 * constants, so no job URL, host or credential can leak through this field,
 * whatever the underlying error happened to contain.
 */

export const PACKAGE_FAILURE_REASONS = [
  // The media could not be parsed: container or codec the packaging tool
  // cannot read. The remedy belongs to whoever supplied the media.
  'unsupported_media',
  // A credential the packager was given was rejected. Needs an operator;
  // retrying is pointless.
  'invalid_credentials',
  // Catch-all: it failed, with no class we can name.
  'packaging_failed'
] as const;

export type PackageFailureReason = (typeof PACKAGE_FAILURE_REASONS)[number];

export const DEFAULT_PACKAGE_FAILURE_REASON: PackageFailureReason =
  'packaging_failed';

/**
 * Media the packaging tool cannot parse.
 *
 * `parser failure` is the token the underlying tool reports for an unreadable
 * container or codec, and the one the consumer's own text classifier looks for
 * (`PARSER_FAILURE_PATTERN`, `package-failure-detail.ts`); matched the same
 * way here — case-insensitively, allowing a space or hyphen for the underscore
 * — because it reaches us inside prose composed further up the stack. The
 * `unsupported <container|codec|...>` and `cannot parse` wordings are the other
 * forms observed for the same class.
 *
 * Deliberately NOT matched: `Unsupported protocol for download/upload: ...`
 * from the packaging library, which is a destination/configuration problem, not
 * a verdict on the media. The `(?:container|codec|media|format|input)` list keeps those
 * out.
 */
const UNSUPPORTED_MEDIA_PATTERN =
  /parser[\s_-]?failure|unsupported\s+(?:container|codec|media|format|input)|(?:cannot|can not|can't|could\s+not|unable\s+to|failed\s+to)\s+(?:parse|demux|probe)\b/i;

/**
 * A rejected credential.
 *
 * Mirrors the consumer's `AUTH_FAILURE_PATTERN` and adds the two credential
 * errors this repo's own dependencies raise verbatim (`Service Access Token
 * expired`, `Personal access token is required ...`).
 *
 * 403 is deliberately absent, for the same reason the consumer leaves it out:
 * on this path a 403 is an object-storage permission verdict on the media, not
 * a verdict on the token, and classifying it as a credential failure would send
 * an operator after a credential that is fine.
 */
const INVALID_CREDENTIALS_PATTERN =
  /\b401\b|unauthori[sz]ed|invalid[\s_-]+(?:access[\s_-]+)?token|token[\s_-]+(?:is[\s_-]+)?(?:invalid|expired|rejected|required)|access[\s_-]+token[\s_-]+is[\s_-]+required|authentication[\s_-]+failed|forbidden[\s_-]+credential/i;

/**
 * Error class names that assert a rejected credential on their own, so the
 * class is honoured even when the message is uninformative. `TokenExpiredError`
 * and `UnauthorizedError` are the exported error classes of
 * `@osaas/client-core` (`lib/errors.js`); matched by name rather than
 * `instanceof` because the error is routinely re-wrapped before it gets here
 * (`src/redisListener.ts:179-180`) and because a name comparison cannot be
 * defeated by a duplicated copy of the dependency.
 */
const INVALID_CREDENTIALS_ERROR_NAMES = new Set([
  'tokenexpirederror',
  'unauthorizederror'
]);

/**
 * HTTP statuses on an error object that assert a rejected credential.
 * `@osaas/client-core`'s `FetchError` carries the status as `httpCode`
 * (`lib/fetch.js`); `status`/`statusCode` are the other two spellings seen on
 * errors raised around `fetch`. 401 only — see `INVALID_CREDENTIALS_PATTERN`
 * for why 403 is excluded.
 */
const INVALID_CREDENTIALS_STATUSES = new Set([401]);
const HTTP_STATUS_MEMBERS = ['httpCode', 'status', 'statusCode'] as const;

// How far down a `cause` chain to look. Bounded so a cyclic or absurdly deep
// chain cannot turn a failure report into a hang.
const MAX_CAUSE_DEPTH = 4;

function readMember(value: object, member: string): unknown {
  try {
    // A getter on a hostile error can throw; a failure report must not.
    return (value as Record<string, unknown>)[member];
  } catch {
    return undefined;
  }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object' || typeof value === 'function') {
    const message = readMember(value as object, 'message');
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  try {
    return String(value);
  } catch {
    // A thrown `toString`/`Symbol.toPrimitive`, or a bare symbol.
    return '';
  }
}

function nameOf(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return '';
  }
  const name = readMember(value, 'name');
  if (typeof name === 'string' && name.length > 0) {
    return name;
  }
  const ctor = readMember(value, 'constructor');
  if (ctor && (typeof ctor === 'object' || typeof ctor === 'function')) {
    const ctorName = readMember(ctor as object, 'name');
    if (typeof ctorName === 'string') {
      return ctorName;
    }
  }
  return '';
}

function hasCredentialStatus(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return HTTP_STATUS_MEMBERS.some((member) => {
    const status = readMember(value, member);
    return (
      typeof status === 'number' && INVALID_CREDENTIALS_STATUSES.has(status)
    );
  });
}

/**
 * The error itself plus its `cause` chain, bounded in depth and cycle-safe.
 * Node wraps a lower-level failure as `new Error(msg, { cause })`, so the
 * class and status that name the failure can sit one or more links down.
 */
function errorChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current === null || current === undefined) {
      break;
    }
    if (typeof current === 'object' || typeof current === 'function') {
      if (seen.has(current)) {
        break;
      }
      seen.add(current);
    }
    chain.push(current);
    if (current === null || typeof current !== 'object') {
      break;
    }
    current = readMember(current, 'cause');
  }
  return chain;
}

/**
 * Classify a packaging failure into one of `PACKAGE_FAILURE_REASONS`.
 *
 * Deterministic and total: same input, same token, always one of the three,
 * never a throw. `fallbackText` is the free-text message the callback sends
 * anyway, consulted only when the error yields no text of its own (an
 * `undefined` error, or one whose `message` is unreadable) — it is the same
 * text, already redacted by the caller.
 *
 * Precedence follows the consumer's classifier: unparseable media first (most
 * specific, and the one whose remedy sits with the caller), then a rejected
 * credential, then the catch-all.
 */
export function derivePackageFailureReason(
  err: unknown,
  fallbackText?: string
): PackageFailureReason {
  try {
    const chain = errorChain(err);
    const texts = chain.map(textOf).filter((text) => text.length > 0);
    if (texts.length === 0 && typeof fallbackText === 'string') {
      texts.push(fallbackText);
    }
    if (texts.some((text) => UNSUPPORTED_MEDIA_PATTERN.test(text))) {
      return 'unsupported_media';
    }
    if (
      texts.some((text) => INVALID_CREDENTIALS_PATTERN.test(text)) ||
      chain.some((link) =>
        INVALID_CREDENTIALS_ERROR_NAMES.has(nameOf(link).toLowerCase())
      ) ||
      chain.some(hasCredentialStatus)
    ) {
      return 'invalid_credentials';
    }
    return DEFAULT_PACKAGE_FAILURE_REASON;
  } catch {
    // Classification must never be the reason a failure goes unreported.
    return DEFAULT_PACKAGE_FAILURE_REASON;
  }
}

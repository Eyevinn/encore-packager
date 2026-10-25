import { Static, Type } from '@sinclair/typebox';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Local mirror of the `EncryptionOptions` shape that
 * `@eyevinn/shaka-packager-s3` is adding to `PackageOptions`
 * (Eyevinn/shaka-packager-s3#26).
 *
 * The installed version of the packager library (verified against
 * `node_modules/@eyevinn/shaka-packager-s3/dist/packager.d.ts`, where
 * `PackageOptions` has no `encryption` member) does not accept encryption
 * options yet, so this package keeps its own schema and refuses jobs that ask
 * for encryption until a packager release that supports it is installed. See
 * `supportsEncryption` below.
 *
 * Keys and key ids are 16 bytes expressed as 32 hex characters, as described in
 * the upstream issue.
 */
const HEX_16_BYTES = '^[0-9a-fA-F]{32}$';

export const EncryptionKey = Type.Object(
  {
    label: Type.Optional(Type.String()),
    keyId: Type.String({ pattern: HEX_16_BYTES }),
    key: Type.String({ pattern: HEX_16_BYTES })
  },
  { additionalProperties: false }
);

export const ProtectionSystem = Type.Union([
  Type.Literal('widevine'),
  Type.Literal('playready'),
  Type.Literal('fairplay'),
  Type.Literal('marlin'),
  Type.Literal('common')
]);

export const EncryptionOptions = Type.Object(
  {
    scheme: Type.Union([Type.Literal('cenc'), Type.Literal('cbcs')]),
    keys: Type.Array(EncryptionKey, { minItems: 1 }),
    protectionSystems: Type.Optional(
      Type.Array(ProtectionSystem, { minItems: 1 })
    ),
    pssh: Type.Optional(
      Type.Object(
        {
          widevine: Type.Optional(Type.String()),
          playready: Type.Optional(Type.String())
        },
        { additionalProperties: false }
      )
    ),
    hlsKeyUri: Type.Optional(Type.String()),
    clearLead: Type.Optional(Type.Number({ minimum: 0 }))
  },
  { additionalProperties: false }
);

export type EncryptionOptions = Static<typeof EncryptionOptions>;

export const REDACTED = '[REDACTED]';

/**
 * First `@eyevinn/shaka-packager-s3` version that accepts
 * `PackageOptions.encryption`. Bump this when the release landing
 * Eyevinn/shaka-packager-s3#26 is published and this package's dependency
 * range is raised to it.
 */
export const MIN_PACKAGER_VERSION_WITH_ENCRYPTION = '0.7.0';

const PACKAGER_PACKAGE_NAME = '@eyevinn/shaka-packager-s3';

function parseVersion(version: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Version of the installed packager library, read from its own package.json.
 * Returns undefined when the version cannot be determined.
 */
export function installedPackagerVersion(): string | undefined {
  try {
    let dir = dirname(require.resolve(PACKAGER_PACKAGE_NAME));
    for (let i = 0; i < 5; i++) {
      const manifestPath = join(dir, 'package.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        if (manifest?.name === PACKAGER_PACKAGE_NAME) {
          return typeof manifest.version === 'string'
            ? manifest.version
            : undefined;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Whether the given packager version accepts per-job encryption options.
 * An unknown version is treated as unsupported: failing the job is better than
 * silently producing unencrypted output.
 */
export function supportsEncryption(
  version: string | undefined = installedPackagerVersion()
): boolean {
  if (!version) {
    return false;
  }
  const parsed = parseVersion(version);
  const minimum = parseVersion(MIN_PACKAGER_VERSION_WITH_ENCRYPTION);
  if (!parsed || !minimum) {
    return false;
  }
  return compareVersions(parsed, minimum) >= 0;
}

/**
 * Throws unless the installed packager can apply encryption. Used before
 * packaging so that a job asking for encryption fails explicitly instead of
 * producing unencrypted output.
 */
export function assertEncryptionSupported(
  version: string | undefined = installedPackagerVersion()
): void {
  if (!supportsEncryption(version)) {
    throw new Error(
      `Encryption was requested but the installed ${PACKAGER_PACKAGE_NAME} version ` +
        `(${version ?? 'unknown'}) does not support it. ` +
        `Install ${MIN_PACKAGER_VERSION_WITH_ENCRYPTION} or later, or submit the job without encryption.`
    );
  }
}

/** Copy of the encryption options with all key material replaced. */
export function redactEncryption<T extends EncryptionOptions>(
  encryption: T
): T {
  return {
    ...encryption,
    keys: encryption.keys.map((k) => ({ ...k, key: REDACTED }))
  };
}

/**
 * Copy of an arbitrary object with `encryption.keys[].key` replaced, safe to
 * log or include in an error message.
 */
export function redactEncryptionIn<T>(value: T): T {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  const encryption = record.encryption;
  if (!encryption || typeof encryption !== 'object') {
    return value;
  }
  const keys = (encryption as Record<string, unknown>).keys;
  if (!Array.isArray(keys)) {
    return value;
  }
  return {
    ...record,
    encryption: {
      ...(encryption as Record<string, unknown>),
      keys: keys.map((k) =>
        k && typeof k === 'object' ? { ...k, key: REDACTED } : k
      )
    }
  } as T;
}

/**
 * Replaces every occurrence of the job's key values in free-form text, for
 * example an error message or a command line produced by the packager.
 */
export function redactKeyMaterialInText(
  text: string,
  encryption?: EncryptionOptions
): string {
  if (!encryption) {
    return text;
  }
  return encryption.keys.reduce(
    (acc, k) => (k.key ? acc.split(k.key).join(REDACTED) : acc),
    text
  );
}

/**
 * Collects the key values found at `encryption.keys[].key` of an arbitrary,
 * possibly invalid, parsed message. Defensive on purpose: a message that
 * failed validation can still carry key material.
 */
export function collectKeyMaterial(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const encryption = (parsed as Record<string, unknown>).encryption;
  if (!encryption || typeof encryption !== 'object') {
    return [];
  }
  const keys = (encryption as Record<string, unknown>).keys;
  if (!Array.isArray(keys)) {
    return [];
  }
  return keys
    .map((k) =>
      k && typeof k === 'object'
        ? (k as Record<string, unknown>).key
        : undefined
    )
    .filter((key): key is string => typeof key === 'string' && key.length > 0);
}

/**
 * Matches a `key` member and its value in JSON-ish or free-form text, however
 * the member is written: `"key": "<hex>"`, `"key":<hex>` (unquoted, so the
 * message never parses), `key=<hex>` (a packager command line) and the
 * truncated forms that appear inside a `JSON.parse` error message, which
 * quotes the offending fragment of the input.
 *
 * `keyId`, `key_id` and `keys` are deliberately not matched: the member name
 * must end immediately after `key`, so key ids and labels stay readable in
 * logs.
 *
 * A fresh RegExp per call keeps `lastIndex` state out of the shared module
 * scope.
 */
function keyMemberPattern(): RegExp {
  const name = String.raw`(?:"key"|key)(?![\w"'-])\s*[:=]\s*`;
  const value = String.raw`"(?:[^"\\]|\\.)*"?|[^\s,}\]{"']+`;
  return new RegExp(`(${name})(${value})`, 'g');
}

/**
 * Redacts the value of every `key` member found in arbitrary text, whether or
 * not the value is quoted and whether or not the text is valid JSON. Used as
 * the last line of defence on anything derived from a queue message: a
 * malformed message, or a parse error quoting part of one, must not leak key
 * material even when the key value could never be read as a string.
 */
export function redactKeyMembersInText(text: string): string {
  return text.replace(keyMemberPattern(), `$1"${REDACTED}"`);
}

/** Minimum length for a key value recovered from raw text to be substituted
 * out of unrelated text, so a short or junk value cannot garble a message. */
const MIN_RECOVERED_KEY_LENGTH = 8;

/**
 * Collects key values from raw, possibly unparseable text, for example the
 * serialised queue message when `JSON.parse` has failed. Complements
 * `collectKeyMaterial`, which needs a successfully parsed message.
 */
export function collectKeyMaterialFromText(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(keyMemberPattern())) {
    const raw = match[2];
    const value = raw.startsWith('"') ? raw.slice(1).replace(/"$/, '') : raw;
    if (value.length >= MIN_RECOVERED_KEY_LENGTH && value !== REDACTED) {
      found.push(value);
    }
  }
  return found;
}

/**
 * Removes any key material belonging to the given parsed message from
 * free-form text, for example an error thrown further down the stack.
 *
 * `rawMessage` is the serialised message the text relates to, if available.
 * It is needed because the message may have failed to parse — in which case
 * `parsed` is undefined and carries no keys at all — while the raw string, and
 * any parse error quoting it, still hold the key.
 */
export function redactKeyMaterialFor(
  text: string,
  parsed: unknown,
  rawMessage?: string
): string {
  const keys = [
    ...collectKeyMaterial(parsed),
    ...(rawMessage ? collectKeyMaterialFromText(rawMessage) : [])
  ];
  const withoutKeys = keys.reduce(
    (acc, key) => acc.split(key).join(REDACTED),
    text
  );
  return redactKeyMembersInText(withoutKeys);
}

/**
 * Redacts key material in a raw string, typically the serialised queue
 * message. Parses it as JSON when possible and always falls back to replacing
 * any `key` member, quoted or not, so a malformed message cannot leak key
 * material either.
 */
export function redactMessageString(message: string): string {
  try {
    const parsed = JSON.parse(message);
    const redacted = redactEncryptionIn(parsed);
    if (redacted !== parsed) {
      return redactKeyMembersInText(JSON.stringify(redacted));
    }
    return redactKeyMembersInText(message);
  } catch {
    return redactKeyMembersInText(message);
  }
}

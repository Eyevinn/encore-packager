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
 * Removes any key material belonging to the given parsed message from
 * free-form text, for example an error thrown further down the stack.
 */
export function redactKeyMaterialFor(text: string, parsed: unknown): string {
  return collectKeyMaterial(parsed).reduce(
    (acc, key) => acc.split(key).join(REDACTED),
    text
  );
}

const KEY_FIELD_PATTERN = /("key"\s*:\s*)"(?:[^"\\]|\\.)*"/g;

/**
 * Redacts key material in a raw string, typically the serialised queue
 * message. Parses it as JSON when possible and falls back to replacing any
 * `"key": "..."` member, so a malformed message cannot leak key material
 * either.
 */
export function redactMessageString(message: string): string {
  try {
    const parsed = JSON.parse(message);
    const redacted = redactEncryptionIn(parsed);
    if (redacted !== parsed) {
      return JSON.stringify(redacted);
    }
    return message.replace(KEY_FIELD_PATTERN, `$1"${REDACTED}"`);
  } catch {
    return message.replace(KEY_FIELD_PATTERN, `$1"${REDACTED}"`);
  }
}

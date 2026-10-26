import {
  EncryptionOptions,
  MIN_PACKAGER_VERSION_WITH_ENCRYPTION,
  REDACTED,
  assertEncryptionSupported,
  installedPackagerVersion,
  redactEncryption,
  redactEncryptionIn,
  redactKeyMaterialInText,
  redactMessageString,
  supportsEncryption
} from './encryption';

const KEY = 'aabbccddeeff00112233445566778899';
const KEY_ID = '00112233445566778899aabbccddeeff';

const encryption: EncryptionOptions = {
  scheme: 'cenc',
  keys: [{ label: 'HD', keyId: KEY_ID, key: KEY }]
};

describe('Packager encryption support detection', () => {
  it('Reads the installed packager version', () => {
    expect(installedPackagerVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
  it('Treats versions below the minimum as unsupported', () => {
    expect(supportsEncryption('0.6.3')).toBe(false);
    expect(supportsEncryption('0.1.0')).toBe(false);
  });
  it('Treats the minimum version and later as supported', () => {
    expect(supportsEncryption(MIN_PACKAGER_VERSION_WITH_ENCRYPTION)).toBe(true);
    expect(supportsEncryption('0.7.1')).toBe(true);
    expect(supportsEncryption('1.0.0')).toBe(true);
    expect(supportsEncryption('0.8.0-rc.1')).toBe(true);
  });
  it('Treats an unknown or unparsable version as unsupported', () => {
    expect(supportsEncryption(undefined)).toBe(false);
    expect(supportsEncryption('')).toBe(false);
    expect(supportsEncryption('not-a-version')).toBe(false);
  });
  it('Fails explicitly when encryption is unsupported', () => {
    expect(() => assertEncryptionSupported('0.6.3')).toThrow(
      /does not support it/
    );
    expect(() => assertEncryptionSupported('not-a-version')).toThrow(
      /does not support it/
    );
    // with no argument it checks the installed version
    if (supportsEncryption()) {
      expect(() => assertEncryptionSupported()).not.toThrow();
    } else {
      expect(() => assertEncryptionSupported()).toThrow(/does not support it/);
    }
    expect(() =>
      assertEncryptionSupported(MIN_PACKAGER_VERSION_WITH_ENCRYPTION)
    ).not.toThrow();
  });
});

describe('Encryption redaction', () => {
  it('Redacts key values but keeps key ids and labels', () => {
    const redacted = redactEncryption(encryption);
    expect(redacted.keys[0].key).toEqual(REDACTED);
    expect(redacted.keys[0].keyId).toEqual(KEY_ID);
    expect(redacted.keys[0].label).toEqual('HD');
    expect(JSON.stringify(redacted)).not.toContain(KEY);
    // the input is not mutated
    expect(encryption.keys[0].key).toEqual(KEY);
  });
  it('Redacts key values in an arbitrary object', () => {
    const message = { jobId: 'id', url: 'http://localhost/job', encryption };
    const redacted = redactEncryptionIn(message);
    expect(JSON.stringify(redacted)).not.toContain(KEY);
    expect(redacted.url).toEqual('http://localhost/job');
    expect(message.encryption.keys[0].key).toEqual(KEY);
  });
  it('Leaves objects without encryption untouched', () => {
    const message = { jobId: 'id', url: 'http://localhost/job' };
    expect(redactEncryptionIn(message)).toBe(message);
    expect(redactEncryptionIn(undefined)).toBeUndefined();
    expect(redactEncryptionIn('string')).toEqual('string');
  });
  it('Redacts key values in a serialised message', () => {
    const serialised = JSON.stringify({
      jobId: 'id',
      url: 'http://localhost/job',
      encryption
    });
    const redacted = redactMessageString(serialised);
    expect(redacted).not.toContain(KEY);
    expect(redacted).toContain(KEY_ID);
  });
  it('Leaves a message without encryption unchanged', () => {
    const serialised = '{"jobId":"id","url":"http://localhost/job"}';
    expect(redactMessageString(serialised)).toEqual(serialised);
  });
  it('Redacts key values in a malformed message', () => {
    const malformed = `{"jobId":"id","encryption":{"keys":[{"key":"${KEY}"`;
    expect(redactMessageString(malformed)).not.toContain(KEY);
  });
  it('Redacts key material in free-form text', () => {
    const text = `shaka failed: --keys label=HD:key_id=${KEY_ID}:key=${KEY}`;
    const redacted = redactKeyMaterialInText(text, encryption);
    expect(redacted).not.toContain(KEY);
    expect(redacted).toContain(REDACTED);
    expect(redactKeyMaterialInText(text, undefined)).toEqual(text);
  });
});

import {
  DEFAULT_OUTPUT_SUBFOLDER_TEMPLATE,
  DEFAULT_STREAM_KEY_TEMPLATES,
  PackagingConfig
} from './config';
import { EncryptionOptions } from './encryption';

const doPackage = jest.fn();

jest.mock('@eyevinn/shaka-packager-s3', () => ({
  doPackage: (...args: unknown[]) => doPackage(...args)
}));

const logged: string[] = [];

jest.mock('./logger', () => ({
  __esModule: true,
  default: {
    info: (...args: unknown[]) => logged.push(args.map(String).join(' ')),
    warn: (...args: unknown[]) => logged.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => logged.push(args.map(String).join(' ')),
    debug: (...args: unknown[]) => logged.push(args.map(String).join(' '))
  }
}));

const supportsEncryption = jest.fn().mockReturnValue(true);

jest.mock('./encryption', () => {
  const actual = jest.requireActual('./encryption');
  return {
    ...actual,
    supportsEncryption: (...args: unknown[]) => supportsEncryption(...args),
    assertEncryptionSupported: (version?: string) => {
      if (!supportsEncryption(version)) {
        throw new Error(
          'Encryption was requested but the installed @eyevinn/shaka-packager-s3 version does not support it.'
        );
      }
    }
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EncorePackager } = require('./encorePackager');

const KEY = 'aabbccddeeff00112233445566778899';
const KEY_ID = '00112233445566778899aabbccddeeff';

const encryption: EncryptionOptions = {
  scheme: 'cenc',
  keys: [{ label: 'HD', keyId: KEY_ID, key: KEY }],
  clearLead: 2
};

const config: PackagingConfig = {
  outputFolder: '/tmp/packaged',
  outputSubfolderTemplate: DEFAULT_OUTPUT_SUBFOLDER_TEMPLATE,
  concurrency: 1,
  streamKeysConfig: DEFAULT_STREAM_KEY_TEMPLATES,
  manifestNamesConfig: {},
  skipPackaging: false,
  downloadRetryCount: 1,
  downloadRetryDelaySeconds: 1,
  downloadMaxTimeSeconds: 10,
  downloadAppRetryAttempts: 1
} as PackagingConfig;

const encoreJob = {
  id: 'e5e76304-744c-41d6-85f7-69007b3b1a65',
  status: 'SUCCESSFUL',
  output: [
    {
      file: '/data/out/test_x264_3100.mp4',
      format: 'mp4',
      fileSize: 1,
      overallBitrate: 1,
      videoStreams: [{ codec: 'h264', bitrate: 2979615 }],
      audioStreams: [],
      type: 'VideoFile'
    }
  ],
  inputs: [{ uri: 'https://assets.test.com/test-asset.mp4' }]
};

beforeEach(() => {
  logged.length = 0;
  doPackage.mockReset();
  supportsEncryption.mockReset().mockReturnValue(true);
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => encoreJob
  }) as unknown as typeof fetch;
});

describe('EncorePackager per-job encryption', () => {
  it('Does not pass any encryption option when the job has none', async () => {
    await new EncorePackager(config).package('http://localhost/job/1');
    expect(doPackage).toHaveBeenCalledTimes(1);
    expect(doPackage.mock.calls[0][0]).not.toHaveProperty('encryption');
  });

  it('Passes the per-job encryption to the packager for that job only', async () => {
    const packager = new EncorePackager(config);
    await packager.package('http://localhost/job/1', encryption);
    expect(doPackage.mock.calls[0][0].encryption).toEqual(encryption);

    await packager.package('http://localhost/job/2');
    expect(doPackage.mock.calls[1][0]).not.toHaveProperty('encryption');
  });

  it('Fails the job instead of packaging unencrypted when the packager has no encryption support', async () => {
    supportsEncryption.mockReturnValue(false);
    await expect(
      new EncorePackager(config).package('http://localhost/job/1', encryption)
    ).rejects.toThrow(/does not support it/);
    expect(doPackage).not.toHaveBeenCalled();
  });

  it('Fails the job when packaging is skipped for the instance', async () => {
    await expect(
      new EncorePackager({
        ...config,
        skipPackaging: true
      }).copyAndGenerateSmil('http://localhost/job/1', encryption)
    ).rejects.toThrow(/unencrypted/);
  });

  it('Never logs key material, and scrubs it from packager errors', async () => {
    doPackage.mockRejectedValue(
      new Error(`shaka failed: --keys key_id=${KEY_ID}:key=${KEY}`)
    );
    await expect(
      new EncorePackager(config).package('http://localhost/job/1', encryption)
    ).rejects.toThrow(/\[REDACTED\]/);

    const thrown = await new EncorePackager(config)
      .package('http://localhost/job/1', encryption)
      .catch((err: Error) => err.message);
    expect(thrown).not.toContain(KEY);
    expect(logged.join('\n')).not.toContain(KEY);
    expect(logged.join('\n')).toContain('[REDACTED]');
    // key ids and labels are not secret and stay visible for debugging
    expect(logged.join('\n')).toContain(KEY_ID);
  });
});

import { RedisConfig } from './config';
import { EncryptionOptions } from './encryption';

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

const zAdd = jest.fn();

jest.mock('redis', () => ({
  createClient: () => ({
    on: () => ({
      connect: async () => ({
        zAdd: (...args: unknown[]) => zAdd(...args),
        quit: async () => undefined,
        isReady: true
      })
    }),
    connect: async () => ({
      zAdd: (...args: unknown[]) => zAdd(...args),
      quit: async () => undefined,
      isReady: true
    })
  }),
  createCluster: () => ({
    on: () => ({ connect: async () => undefined })
  })
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RedisListener, validateQueueMessage } = require('./redisListener');

const KEY = 'aabbccddeeff00112233445566778899';
const KEY_ID = '00112233445566778899aabbccddeeff';

const encryption: EncryptionOptions = {
  scheme: 'cbcs',
  keys: [{ label: 'HD', keyId: KEY_ID, key: KEY }],
  protectionSystems: ['widevine', 'playready'],
  pssh: { widevine: 'AAAAKXBzc2g=' },
  hlsKeyUri: `skd://${KEY_ID}`,
  clearLead: 0
};

const redisConfig: RedisConfig = {
  url: 'redis://localhost:6379',
  queueName: 'packaging-queue',
  clusterMode: false
};

beforeEach(() => {
  logged.length = 0;
  zAdd.mockReset();
});

describe('Queue message validation', () => {
  it('Accepts a message without encryption, as before', () => {
    expect(() =>
      validateQueueMessage({ jobId: 'id', url: 'http://localhost/job' })
    ).not.toThrow();
  });
  it('Accepts a message with valid encryption options', () => {
    expect(() =>
      validateQueueMessage({
        jobId: 'id',
        url: 'http://localhost/job',
        encryption
      })
    ).not.toThrow();
  });
  it('Accepts the minimal encryption object', () => {
    expect(() =>
      validateQueueMessage({
        jobId: 'id',
        url: 'http://localhost/job',
        encryption: { scheme: 'cenc', keys: [{ keyId: KEY_ID, key: KEY }] }
      })
    ).not.toThrow();
  });
  it('Still rejects a message missing the required fields', () => {
    expect(() => validateQueueMessage({ jobId: 'id' })).toThrow(
      /Invalid message/
    );
    expect(() => validateQueueMessage({ url: 'http://localhost/job' })).toThrow(
      /Invalid message/
    );
  });

  const invalid: [string, unknown][] = [
    [
      'unknown scheme',
      { scheme: 'aes-ctr', keys: [{ keyId: KEY_ID, key: KEY }] }
    ],
    ['no keys', { scheme: 'cenc', keys: [] }],
    ['missing keys', { scheme: 'cenc' }],
    ['missing scheme', { keys: [{ keyId: KEY_ID, key: KEY }] }],
    ['short key', { scheme: 'cenc', keys: [{ keyId: KEY_ID, key: 'aabb' }] }],
    [
      'non-hex key',
      {
        scheme: 'cenc',
        keys: [{ keyId: KEY_ID, key: 'zzbbccddeeff00112233445566778899' }]
      }
    ],
    ['short key id', { scheme: 'cenc', keys: [{ keyId: '0011', key: KEY }] }],
    [
      'unknown protection system',
      {
        scheme: 'cenc',
        keys: [{ keyId: KEY_ID, key: KEY }],
        protectionSystems: ['some-other-system']
      }
    ],
    [
      'negative clear lead',
      { scheme: 'cenc', keys: [{ keyId: KEY_ID, key: KEY }], clearLead: -1 }
    ],
    [
      'misspelled member',
      { scheme: 'cenc', keys: [{ keyId: KEY_ID, key: KEY }], clear_lead: 3 }
    ],
    [
      'misspelled key member',
      { scheme: 'cenc', keys: [{ keyid: KEY_ID, key: KEY }] }
    ],
    ['not an object', 'cenc']
  ];

  it.each(invalid)('Rejects encryption with %s', (_name, badEncryption) => {
    expect(() =>
      validateQueueMessage({
        jobId: 'id',
        url: 'http://localhost/job',
        encryption: badEncryption
      })
    ).toThrow(/Invalid message/);
  });

  it('Does not include key material in the validation error', () => {
    try {
      validateQueueMessage({
        jobId: 'id',
        url: 'http://localhost/job',
        encryption: { scheme: 'not-a-scheme', keys: [{ keyId: '0', key: KEY }] }
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/Invalid message/);
      expect((err as Error).message).not.toContain(KEY);
    }
  });
});

describe('RedisListener message handling', () => {
  it('Passes a message without encryption straight through, as before', async () => {
    const onMessage = jest.fn().mockResolvedValue('/out/path');
    const listener = new RedisListener(redisConfig, onMessage, 1);
    const message = JSON.stringify({
      jobId: 'id',
      url: 'http://localhost/job'
    });

    await listener.handleMessage(message);

    expect(onMessage).toHaveBeenCalledWith({
      jobId: 'id',
      url: 'http://localhost/job'
    });
    expect(logged.join('\n')).toContain(message);
  });

  it('Passes per-job encryption through to the job handler untouched', async () => {
    const onMessage = jest.fn().mockResolvedValue('/out/path');
    const listener = new RedisListener(redisConfig, onMessage, 1);

    await listener.handleMessage(
      JSON.stringify({ jobId: 'id', url: 'http://localhost/job', encryption })
    );

    expect(onMessage).toHaveBeenCalledWith({
      jobId: 'id',
      url: 'http://localhost/job',
      encryption
    });
  });

  it('Rejects an invalid encryption object without running the job', async () => {
    const onMessage = jest.fn();
    const onPackageFail = jest.fn();
    const listener = new RedisListener(redisConfig, onMessage, 1, {
      onPackageFail
    });

    await listener.handleMessage(
      JSON.stringify({
        jobId: 'id',
        url: 'http://localhost/job',
        encryption: { scheme: 'cenc', keys: [] }
      })
    );

    expect(onMessage).not.toHaveBeenCalled();
    expect(onPackageFail).toHaveBeenCalled();
  });

  it('Never logs or reports key material, on success or failure', async () => {
    const failing = jest
      .fn()
      .mockRejectedValue(
        new Error(`shaka failed with --keys key_id=${KEY_ID}:key=${KEY}`)
      );
    const onPackageFail = jest.fn();
    const listener = new RedisListener(redisConfig, failing, 1, {
      onPackageFail
    });
    const message = JSON.stringify({
      jobId: 'id',
      url: 'http://localhost/job',
      encryption
    });

    await listener.handleMessage(message);

    expect(failing).toHaveBeenCalled();
    expect(logged.join('\n')).not.toContain(KEY);
    expect(logged.join('\n')).toContain('[REDACTED]');
    const reported = onPackageFail.mock.calls[0][0];
    expect(JSON.stringify(reported)).not.toContain(KEY);

    logged.length = 0;
    const ok = jest.fn().mockResolvedValue('/out/path');
    const okListener = new RedisListener(redisConfig, ok, 1);
    await okListener.handleMessage(message);
    expect(logged.join('\n')).not.toContain(KEY);
  });

  it('Never logs key material when retrying a job, but requeues it intact', async () => {
    const listener = new RedisListener(redisConfig, jest.fn(), 1);
    const message = { jobId: 'id', url: 'http://localhost/job', encryption };

    await listener.retryJob(message);

    expect(logged.join('\n')).not.toContain(KEY);
    expect(zAdd).toHaveBeenCalledTimes(1);
    const queued = zAdd.mock.calls[0][1] as { value: string };
    expect(JSON.parse(queued.value)).toEqual(message);
  });
});

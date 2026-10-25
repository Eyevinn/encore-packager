import { RedisConfig } from './config';
import { CallbackListener } from './callbackListener';

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

jest.mock('redis', () => ({
  createClient: () => ({
    on: () => ({
      connect: async () => ({
        zAdd: async () => undefined,
        quit: async () => undefined,
        isReady: true
      })
    })
  }),
  createCluster: () => ({
    on: () => ({ connect: async () => undefined })
  })
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RedisListener } = require('./redisListener');

// A key that shares no substring with the key id, so asserting on a fragment
// of it cannot be satisfied by the (deliberately unredacted) key id.
const KEY = 'deadbeefdeadbeefdeadbeefdeadbeef';
const KEY_FRAGMENT = 'deadbeef';
const KEY_ID = '00112233445566778899001122334455';

const redisConfig: RedisConfig = {
  url: 'redis://localhost:6379',
  queueName: 'packaging-queue',
  clusterMode: false
};

const callbackBodies: string[] = [];

beforeEach(() => {
  logged.length = 0;
  callbackBodies.length = 0;
  global.fetch = jest.fn(async (_url: unknown, init?: { body?: unknown }) => {
    callbackBodies.push(String(init?.body ?? ''));
    return { ok: true, status: 200 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
});

describe('Malformed messages carrying key material', () => {
  // An unquoted key value makes the whole message unparseable, so the failure
  // path runs with no parsed message to collect keys from and with a parse
  // error that quotes part of the message.
  const unquoted =
    `{"jobId":"id","url":"http://localhost/job","encryption":` +
    `{"scheme":"cenc","keys":[{"keyId":"${KEY_ID}","key":${KEY}}]}}`;

  it('Never logs or reports an unquoted key value', async () => {
    const onMessage = jest.fn();
    const onPackageFail = jest.fn();
    const listener = new RedisListener(redisConfig, onMessage, 1, {
      onPackageFail
    });

    await listener.handleMessage(unquoted);

    expect(onMessage).not.toHaveBeenCalled();
    expect(onPackageFail).toHaveBeenCalled();

    const log = logged.join('\n');
    expect(log).not.toContain(KEY);
    expect(log).not.toContain(KEY_FRAGMENT);
    expect(log).toContain('[REDACTED]');

    const reported = JSON.stringify(onPackageFail.mock.calls[0]);
    expect(reported).not.toContain(KEY);
    expect(reported).not.toContain(KEY_FRAGMENT);
  });

  it('Never POSTs an unquoted key value to the failure callback', async () => {
    const callback = new CallbackListener(new URL('http://callback.local/'));
    const listener = new RedisListener(redisConfig, jest.fn(), 1, callback);

    await listener.handleMessage(unquoted);

    expect(callbackBodies.length).toBe(1);
    expect(callbackBodies[0]).not.toContain(KEY);
    expect(callbackBodies[0]).not.toContain(KEY_FRAGMENT);
    expect(logged.join('\n')).not.toContain(KEY_FRAGMENT);
  });

  it('Never logs a key value written without quotes or spacing variants', async () => {
    const variants = [
      `{"jobId":"id","encryption":{"keys":[{"key": ${KEY}`,
      `{"jobId":"id","encryption":{"keys":[{ key : ${KEY} }]}}`,
      `{"jobId":"id","encryption":{"keys":[{"key"  :  "${KEY}"`,
      `not json at all: key=${KEY}`
    ];

    for (const variant of variants) {
      logged.length = 0;
      const listener = new RedisListener(redisConfig, jest.fn(), 1, {
        onPackageFail: jest.fn()
      });
      await listener.handleMessage(variant);
      expect(logged.join('\n')).not.toContain(KEY);
      expect(logged.join('\n')).not.toContain(KEY_FRAGMENT);
    }
  });
});

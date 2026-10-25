import api from './api';

jest.mock('./logger', () => ({
  __esModule: true,
  default: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined
  }
}));

const KEY = 'aabbccddeeff00112233445566778899';
const KEY_ID = '00112233445566778899aabbccddeeff';

const retryJob = jest.fn();

const server = () =>
  api({
    redisStatus: () => 'UP' as const,
    retryJob,
    title: 'test',
    description: 'test'
  });

beforeEach(() => {
  retryJob.mockReset();
  retryJob.mockResolvedValue(undefined);
});

describe('POST /retry encryption validation', () => {
  it('Requeues a valid encryption object untouched', async () => {
    const app = server();
    const encryption = {
      scheme: 'cbcs',
      keys: [{ label: 'HD', keyId: KEY_ID, key: KEY }],
      protectionSystems: ['widevine'],
      pssh: { widevine: 'AAAAKXBzc2g=' },
      hlsKeyUri: `skd://${KEY_ID}`,
      clearLead: 0
    };

    const response = await app.inject({
      method: 'POST',
      url: '/retry',
      payload: { jobId: 'id', url: 'http://localhost/job', encryption }
    });

    expect(response.statusCode).toBe(200);
    expect(retryJob).toHaveBeenCalledTimes(1);
    expect(retryJob.mock.calls[0][0]).toEqual({
      jobId: 'id',
      url: 'http://localhost/job',
      encryption
    });
    await app.close();
  });

  it('Retries a message without encryption, as before', async () => {
    const app = server();
    const response = await app.inject({
      method: 'POST',
      url: '/retry',
      payload: { jobId: 'id', url: 'http://localhost/job' }
    });
    expect(response.statusCode).toBe(200);
    expect(retryJob).toHaveBeenCalledTimes(1);
    await app.close();
  });

  // Fastify's ajv removes unknown members by default, which would requeue the
  // job with the mistyped member silently dropped - and therefore without the
  // encryption setting the caller asked for.
  const mistyped: [string, Record<string, unknown>][] = [
    ['clear_lead', { clear_lead: 3 }],
    ['protection_systems', { protection_systems: ['widevine'] }],
    ['widevine_pssh', { widevine_pssh: 'AAAAKXBzc2g=' }],
    ['hlskeyuri', { hlskeyuri: `skd://${KEY_ID}` }]
  ];

  it.each(mistyped)(
    'Rejects a body with a mistyped %s member instead of dropping it',
    async (_name, extra) => {
      const app = server();
      const response = await app.inject({
        method: 'POST',
        url: '/retry',
        payload: {
          jobId: 'id',
          url: 'http://localhost/job',
          encryption: {
            scheme: 'cenc',
            keys: [{ keyId: KEY_ID, key: KEY }],
            ...extra
          }
        }
      });

      expect(response.statusCode).toBe(400);
      expect(retryJob).not.toHaveBeenCalled();
      expect(response.body).toContain('Invalid message');
      expect(response.body).not.toContain(KEY);
      await app.close();
    }
  );

  it('Rejects an invalid key without echoing it', async () => {
    const app = server();
    const response = await app.inject({
      method: 'POST',
      url: '/retry',
      payload: {
        jobId: 'id',
        url: 'http://localhost/job',
        encryption: { scheme: 'cenc', keys: [{ keyId: KEY_ID, key: 'aabb' }] }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(retryJob).not.toHaveBeenCalled();
    expect(response.body).not.toContain('aabb');
    await app.close();
  });
});

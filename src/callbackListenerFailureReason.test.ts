import {
  CallbackListener,
  UNSERIALISABLE_FAILURE_MESSAGE
} from './callbackListener';

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

const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });

beforeEach(() => {
  logged.length = 0;
  fetchMock.mockClear();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function failureCall() {
  const [url, init] = fetchMock.mock.calls[0] as [
    string,
    { headers: Record<string, string>; body: string }
  ];
  return { url, rawBody: init.body, body: JSON.parse(init.body) };
}

// The callback body is fixed by the consumer's request schema: `message`
// (required) plus the optional `reason`, additionalProperties false. Verified
// against POST /api/v1/internal/packagerCallback/failure in the consumer's
// openapi.json and its Zod source `packagerFailureSchema`
// (Eyevinn/open-videocore src/routes/internal.ts:121-124).
describe('Failure callback reason (issue #63)', () => {
  const listener = () =>
    new CallbackListener(new URL('http://callback.local/'));

  it('Sends the failure to the failure path with message and reason only', async () => {
    await listener().onPackageFail?.(
      'Packaging of job abc failed: Packager failed',
      new Error('Packager failed')
    );

    const { url, body } = failureCall();
    expect(url).toEqual('http://callback.local/packagerCallback/failure');
    expect(body).toEqual({
      message: 'Packaging of job abc failed: Packager failed',
      reason: 'packaging_failed'
    });
    expect(Object.keys(body).sort()).toEqual(['message', 'reason']);
  });

  it('Sends unsupported_media for media the packaging tool cannot parse', async () => {
    const message = 'Packaging of job abc failed: PARSER_FAILURE';

    await listener().onPackageFail?.(message, new Error(message));

    expect(failureCall().body).toEqual({
      message,
      reason: 'unsupported_media'
    });
  });

  it('Sends invalid_credentials for a rejected credential', async () => {
    const message =
      'Packaging of job abc failed: Failed to fetch job from Encore, got status: 401';

    await listener().onPackageFail?.(message, new Error(message));

    expect(failureCall().body.reason).toEqual('invalid_credentials');
  });

  it('Sends invalid_credentials for an expired service access token', async () => {
    // The stale-token class from Eyevinn/open-videocore#1335, which previously
    // reached the consumer as nothing at all.
    await listener().onPackageFail?.(
      'Packaging of job abc failed',
      new Error('Service Access Token expired')
    );

    expect(failureCall().body.reason).toEqual('invalid_credentials');
  });

  it('Still delivers the failure when the error members throw', async () => {
    const hostile = {
      get message(): string {
        throw new Error('no message for you');
      },
      get cause(): unknown {
        throw new Error('no cause for you');
      }
    };

    await listener().onPackageFail?.('Packaging of job abc failed', hostile);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failureCall().body).toEqual({
      message: 'Packaging of job abc failed',
      reason: 'packaging_failed'
    });
  });

  it('Still delivers the failure when the message cannot be serialised', async () => {
    const unserialisable = {
      toJSON(): never {
        throw new Error('cannot serialise me');
      },
      toString(): string {
        return 'Packaging of job abc failed';
      }
    } as unknown as string;

    await listener().onPackageFail?.(
      unserialisable,
      new Error('PARSER_FAILURE')
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { body } = failureCall();
    expect(body.message).toEqual('Packaging of job abc failed');
    expect(body.reason).toEqual('unsupported_media');
  });

  it('Delivers a usable body even when the message cannot be stringified at all', async () => {
    const hostileMessage = {
      toJSON(): never {
        throw new Error('cannot serialise me');
      },
      toString(): never {
        throw new Error('cannot stringify me');
      }
    } as unknown as string;

    await listener().onPackageFail?.(
      hostileMessage,
      new Error('Packager failed')
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { body } = failureCall();
    expect(body).toEqual({
      message: UNSERIALISABLE_FAILURE_MESSAGE,
      reason: 'packaging_failed'
    });
  });

  it('Logs a failure callback the consumer rejected', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await listener().onPackageFail?.(
      'Packaging of job abc failed',
      new Error('Packager failed')
    );

    expect(logged.join('\n')).toContain('503');
  });
});

import {
  createCallbackListener,
  createJobCallbackListener
} from './callbackListener';
import { readCallbackConfig } from './config';

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
  global.fetch = fetchMock as unknown as typeof fetch;
  delete process.env.CALLBACK_URL;
});

function lastFetch() {
  const [url, init] = fetchMock.mock.calls[0] as [
    string,
    { headers: Record<string, string>; body: string }
  ];
  return { url, headers: init.headers, body: JSON.parse(init.body) };
}

describe('Per-job callback listener', () => {
  it('Sends the success callback to the URL supplied by the job', async () => {
    const listener = createJobCallbackListener(
      'https://job-callback.example.com/hook'
    );

    await listener?.onPackageDone?.('http://encore/job/id', 'id', '/out/path');

    const { url, body } = lastFetch();
    expect(url).toEqual(
      'https://job-callback.example.com/hook/packagerCallback/success'
    );
    expect(body).toEqual({
      url: 'http://encore/job/id',
      jobId: 'id',
      outputPath: '/out/path'
    });
  });

  it('Sends the failure callback to the URL supplied by the job', async () => {
    const listener = createJobCallbackListener(
      'https://job-callback.example.com/hook'
    );

    await listener?.onPackageFail?.('it failed', new Error('it failed'));

    const { url } = lastFetch();
    expect(url).toEqual(
      'https://job-callback.example.com/hook/packagerCallback/failure'
    );
  });

  it('Uses basic-auth credentials embedded in the job callback URL', async () => {
    const listener = createJobCallbackListener(
      'https://user:password@job-callback.example.com/hook'
    );

    await listener?.onPackageDone?.('http://encore/job/id', 'id');

    const { url, headers } = lastFetch();
    expect(url).toEqual(
      'https://job-callback.example.com/hook/packagerCallback/success'
    );
    expect(headers.Authorization).toEqual(
      'Basic ' + Buffer.from('user:password').toString('base64')
    );
  });

  it('Returns no listener when the job has no callback URL, so the configured one is used', () => {
    expect(createJobCallbackListener(undefined)).toBeUndefined();
    expect(createJobCallbackListener('')).toBeUndefined();
  });

  it('Returns no listener for an unusable job callback URL', () => {
    expect(createJobCallbackListener('not a url')).toBeUndefined();
  });
});

describe('Configured callback listener', () => {
  it('Falls back to the CALLBACK_URL callback for a job without its own URL', async () => {
    process.env.CALLBACK_URL = 'https://configured.example.com/hook';
    const configured = createCallbackListener(readCallbackConfig());
    const listener = createJobCallbackListener(undefined) ?? configured;

    await listener?.onPackageDone?.('http://encore/job/id', 'id');

    const { url } = lastFetch();
    expect(url).toEqual(
      'https://configured.example.com/hook/packagerCallback/success'
    );
  });

  it('Prefers the job callback URL over CALLBACK_URL', async () => {
    process.env.CALLBACK_URL = 'https://configured.example.com/hook';
    const configured = createCallbackListener(readCallbackConfig());
    const listener =
      createJobCallbackListener('https://job-callback.example.com/hook') ??
      configured;

    await listener?.onPackageDone?.('http://encore/job/id', 'id');

    const { url } = lastFetch();
    expect(url).toEqual(
      'https://job-callback.example.com/hook/packagerCallback/success'
    );
  });

  it('Returns no listener when CALLBACK_URL is unset', () => {
    expect(createCallbackListener(readCallbackConfig())).toBeUndefined();
  });
});

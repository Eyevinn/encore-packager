import {
  readCallbackConfig,
  readConfig,
  DEFAULT_DOWNLOAD_RETRY_COUNT,
  DEFAULT_DOWNLOAD_RETRY_DELAY_SECONDS,
  DEFAULT_DOWNLOAD_MAX_TIME_SECONDS,
  DEFAULT_DOWNLOAD_APP_RETRY_ATTEMPTS
} from './config';

describe('Test parse download retry config', () => {
  const envKeys = [
    'DOWNLOAD_RETRY_COUNT',
    'DOWNLOAD_RETRY_DELAY_SECONDS',
    'DOWNLOAD_MAX_TIME_SECONDS',
    'DOWNLOAD_APP_RETRY_ATTEMPTS'
  ];

  afterEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  it('defaults all download retry settings when no env vars are set', () => {
    const { packaging } = readConfig();
    expect(packaging.downloadRetryCount).toEqual(DEFAULT_DOWNLOAD_RETRY_COUNT);
    expect(packaging.downloadRetryDelaySeconds).toEqual(
      DEFAULT_DOWNLOAD_RETRY_DELAY_SECONDS
    );
    expect(packaging.downloadMaxTimeSeconds).toEqual(
      DEFAULT_DOWNLOAD_MAX_TIME_SECONDS
    );
    expect(packaging.downloadAppRetryAttempts).toEqual(
      DEFAULT_DOWNLOAD_APP_RETRY_ATTEMPTS
    );
  });

  it('parses overrides for all download retry settings from env vars', () => {
    process.env.DOWNLOAD_RETRY_COUNT = '5';
    process.env.DOWNLOAD_RETRY_DELAY_SECONDS = '10';
    process.env.DOWNLOAD_MAX_TIME_SECONDS = '1800';
    process.env.DOWNLOAD_APP_RETRY_ATTEMPTS = '7';

    const { packaging } = readConfig();
    expect(packaging.downloadRetryCount).toEqual(5);
    expect(packaging.downloadRetryDelaySeconds).toEqual(10);
    expect(packaging.downloadMaxTimeSeconds).toEqual(1800);
    expect(packaging.downloadAppRetryAttempts).toEqual(7);
  });

  it('parses DOWNLOAD_APP_RETRY_ATTEMPTS independently from DOWNLOAD_RETRY_COUNT', () => {
    process.env.DOWNLOAD_RETRY_COUNT = '1';
    process.env.DOWNLOAD_APP_RETRY_ATTEMPTS = '9';

    const { packaging } = readConfig();
    expect(packaging.downloadRetryCount).toEqual(1);
    expect(packaging.downloadAppRetryAttempts).toEqual(9);
  });
});

describe('Test parse callback config', () => {
  it('handles situation without auth', () => {
    process.env.CALLBACK_URL = 'http://callback.com';
    const conf = readCallbackConfig();
    expect(conf.url?.toString()).toEqual('http://callback.com/');
    expect(conf.user).toBeUndefined;
    expect(conf.password).toBeUndefined;
  });
  it('Handles auth in url', () => {
    process.env.CALLBACK_URL = 'http://user:password@callback.com';
    const conf = readCallbackConfig();
    expect(conf.user).toEqual('user');
    expect(conf.password).toEqual('password');
    expect(conf.url?.toString()).toEqual('http://callback.com/');
  });
  it('handles incorrect URLs', () => {
    process.env.CALLBACK_URL = 'This is not a URL';
    const conf = readCallbackConfig();
    expect(conf.password).toBeUndefined;
    expect(conf.user).toBeUndefined;
    expect(conf.url).toBeUndefined;
  });
  it('url', () => {
    const x = new URL('http://callback.com');
    expect(x).not.toBeNull;
  });
});

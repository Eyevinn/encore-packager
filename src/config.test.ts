import { readCallbackConfig } from './config';

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

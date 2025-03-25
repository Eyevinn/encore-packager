import { readCallbackConfig } from './config';

describe('Test parse callback config', () => {
  it('handles situation without auth', () => {
    process.env.CALLBACK_URL = 'http://callback.com';
    const conf = readCallbackConfig();
    expect(conf).toEqual({
      url: 'http://callback.com/',
      user: undefined,
      password: undefined
    });
  });
  it('Handles auth in url', () => {
    process.env.CALLBACK_URL = 'http://user:password@callback.com';
    const conf = readCallbackConfig();
    expect(conf).toEqual({
      url: 'http://callback.com/',
      user: 'user',
      password: 'password'
    });
  });
});

import { Context } from '@osaas/client-core';
import logger from './logger';
import { PackageListener } from './packageListener';

const ENCORE_BASIC_AUTH_USER = 'user';

export class CallbackListener implements PackageListener {
  constructor(
    private url: string,
    private encorePassword?: string,
    private oscAccessToken?: string
  ) {}

  async onPackageDone?(jobUrl: string, jobId: string): Promise<void> {
    const authHeader: { Authorization: string } | Record<string, never> = this
      .encorePassword
      ? {
          Authorization:
            'Basic ' +
            Buffer.from(
              `${ENCORE_BASIC_AUTH_USER}:${this.encorePassword}`
            ).toString('base64')
        }
      : {};

    let sat;
    if (this.oscAccessToken) {
      const ctx = new Context({
        personalAccessToken: this.oscAccessToken
      });
      sat = await ctx.getServiceAccessToken('encore');
    }
    const jwtHeader: { 'x-jwt': string } | Record<string, never> = sat
      ? {
          'x-jwt': `Bearer ${sat}`
        }
      : {};
    const contentTypeHeader = { 'Content-Type': 'application/json' };
    const response = await fetch(`${this.url}/packagerCallback/success`, {
      method: 'POST',
      headers: {
        ...contentTypeHeader,
        ...authHeader,
        ...jwtHeader
      },
      body: JSON.stringify({
        url: jobUrl,
        jobId: jobId
      })
    });
    if (!response.ok) {
      logger.error(
        `Failed to send success callback, got status: ${response.status}`
      );
    }
  }

  //eslint-disable-next-line @typescript-eslint/no-explicit-any
  async onPackageFail?(message: string, err: any) {
    const authHeader: { Authorization: string } | Record<string, never> = this
      .encorePassword
      ? {
          Authorization:
            'Basic ' +
            Buffer.from(
              `${ENCORE_BASIC_AUTH_USER}:${this.encorePassword}`
            ).toString('base64')
        }
      : {};

    let sat;
    if (this.oscAccessToken) {
      const ctx = new Context({
        personalAccessToken: this.oscAccessToken
      });
      sat = await ctx.getServiceAccessToken('encore');
    }
    const jwtHeader: { 'x-jwt': string } | Record<string, never> = sat
      ? {
          'x-jwt': `Bearer ${sat}`
        }
      : {};
    const contentTypeHeader = { 'Content-Type': 'application/json' };
    const response = await fetch(`${this.url}/packagerCallback/failure`, {
      method: 'POST',
      headers: {
        ...contentTypeHeader,
        ...authHeader,
        ...jwtHeader
      },
      body: JSON.stringify({
        message: message
      })
    });
  }
}

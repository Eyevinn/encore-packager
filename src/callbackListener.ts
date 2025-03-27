import { Context } from '@osaas/client-core';
import logger from './logger';
import { PackageListener } from './packageListener';
import { default as PathUtils } from 'path';

export class CallbackListener implements PackageListener {
  constructor(
    private url: URL,
    private authUser?: string,
    private authPassword?: string,
    private oscAccessToken?: string
  ) {}

  async onPackageDone?(jobUrl: string, jobId: string): Promise<void> {
    const headers = await this.generateHeaders(
      this.authUser,
      this.authPassword
    );
    const fetchUrl = new URL(
      PathUtils.join(this.url.pathname, 'packagerCallback/success'),
      this.url
    );
    const response = await fetch(fetchUrl.toString(), {
      method: 'POST',
      headers: headers,
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
    return;
  }

  //eslint-disable-next-line @typescript-eslint/no-explicit-any
  async onPackageFail?(message: string, err: any): Promise<void> {
    const headers = await this.generateHeaders(
      this.authUser,
      this.authPassword
    );
    const fetchUrl = new URL(
      PathUtils.join(this.url.pathname, 'packagerCallback/failure'),
      this.url
    );
    await fetch(fetchUrl.toString(), {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        message: message
      })
    });
    return;
  }

  async generateHeaders(basicAuthUser?: string, basicAuthPassword?: string) {
    const authHeader: { Authorization: string } | Record<string, never> =
      basicAuthPassword && basicAuthUser
        ? {
            Authorization:
              'Basic ' +
              Buffer.from(`${basicAuthUser}:${basicAuthPassword}`).toString(
                'base64'
              )
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
    return {
      ...authHeader,
      ...jwtHeader,
      ...contentTypeHeader
    };
  }
}

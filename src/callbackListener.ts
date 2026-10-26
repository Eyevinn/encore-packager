import { Context } from '@osaas/client-core';
import logger from './logger';
import { PackageListener } from './packageListener';
import { default as PathUtils } from 'path';
import { CallbackConfig, parseCallbackUrl } from './config';

/**
 * Build a listener from a callback config, or undefined when no callback URL
 * is configured. Used for the instance-wide `CALLBACK_URL`.
 */
export function createCallbackListener(
  callback: CallbackConfig,
  oscAccessToken?: string
): CallbackListener | undefined {
  if (!callback.url) {
    return undefined;
  }
  return new CallbackListener(
    callback.url,
    callback.user,
    callback.password,
    oscAccessToken
  );
}

/**
 * Build a listener for a single job's own `callbackUrl`. Returns undefined
 * when the job did not supply one, which is what makes the caller fall back to
 * the instance-wide callback.
 */
export function createJobCallbackListener(
  callbackUrl?: string,
  oscAccessToken?: string
): CallbackListener | undefined {
  if (!callbackUrl) {
    return undefined;
  }
  const callback = parseCallbackUrl(callbackUrl);
  if (!callback.url) {
    logger.warn(
      'Ignoring unusable callbackUrl on job, using configured callback instead'
    );
    return undefined;
  }
  return createCallbackListener(callback, oscAccessToken);
}

export class CallbackListener implements PackageListener {
  constructor(
    private url: URL,
    private authUser?: string,
    private authPassword?: string,
    private oscAccessToken?: string
  ) {}

  async onPackageDone?(
    jobUrl: string,
    jobId: string,
    outputPath?: string
  ): Promise<void> {
    const headers = await this.generateHeaders(
      this.authUser,
      this.authPassword
    );
    const fetchUrl = new URL(
      PathUtils.join(this.url.pathname, 'packagerCallback/success'),
      this.url
    );
    let body: { url: string; jobId: string; outputPath?: string } = {
      url: jobUrl,
      jobId: jobId
    };
    if (outputPath) {
      body = { ...body, outputPath: outputPath };
    }
    const response = await fetch(fetchUrl.toString(), {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
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

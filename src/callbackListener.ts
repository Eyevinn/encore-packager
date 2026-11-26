import { Context } from '@osaas/client-core';
import logger from './logger';
import { PackageListener } from './packageListener';
import { default as PathUtils } from 'path';
import { CallbackConfig, parseCallbackUrl } from './config';
import {
  PackageFailureReason,
  derivePackageFailureReason
} from './packageFailureReason';

/**
 * The failure body sent when the error detail cannot be serialised at all.
 * A fixed string: the point is that the consumer still learns the job failed,
 * instead of learning nothing until its completion watchdog fires 15 minutes
 * later (see `serialiseFailureBody`).
 */
export const UNSERIALISABLE_FAILURE_MESSAGE =
  'Packaging failed, and the error detail could not be serialised for this callback';

/**
 * Serialise the failure callback body, never throwing.
 *
 * The body shape is fixed by the consumer's request schema — `message`
 * (required string) and the optional `reason`, with `additionalProperties:
 * false` — so nothing else may be added here. Contract: POST
 * `<callback>/packagerCallback/failure` in the consumer's `openapi.json`,
 * schema source `packagerFailureSchema` (Eyevinn/open-videocore
 * `src/routes/internal.ts:121-124`).
 *
 * Why the ladder: `message` is typed `string`, but this is the failure path and
 * it is reached with whatever an upstream catch block happened to have, so a
 * value whose `toJSON`/`toString` throws has to be survivable. Losing the text
 * is acceptable; losing the whole failure report is not — that is the
 * stale-token loss in Eyevinn/open-videocore#1335, where nothing reached the
 * consumer and the step only failed at the 15-minute watchdog.
 */
export function serialiseFailureBody(
  message: string,
  reason: PackageFailureReason
): string {
  try {
    return JSON.stringify({ message, reason });
  } catch {
    // Fall through: the value carried a throwing or unserialisable `toJSON`.
  }
  try {
    return JSON.stringify({ message: String(message), reason });
  } catch {
    // Fall through: `String()` itself threw (a throwing `toString`, a symbol).
  }
  // Constants only, so this cannot fail.
  return JSON.stringify({ message: UNSERIALISABLE_FAILURE_MESSAGE, reason });
}

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
    // The error used to be dropped here. It is now classified into the
    // consumer's `reason` vocabulary — `unsupported_media`,
    // `invalid_credentials` or `packaging_failed` — so the failure is
    // attributed in seconds instead of inferred from prose or waited out.
    // Only the token travels: nothing from the error is copied into it.
    const reason = derivePackageFailureReason(err, message);
    const response = await fetch(fetchUrl.toString(), {
      method: 'POST',
      headers: headers,
      body: serialiseFailureBody(message, reason)
    });
    if (!response?.ok) {
      logger.error(
        `Failed to send failure callback (reason ${reason}), got status: ${response?.status}`
      );
    }
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

import {
  DEFAULT_PACKAGE_FAILURE_REASON,
  PACKAGE_FAILURE_REASONS,
  derivePackageFailureReason
} from './packageFailureReason';

// The three tokens the consumer accepts: PACKAGE_FAILURE_REASONS in
// Eyevinn/open-videocore src/pipeline/package-failure-detail.ts, surfaced on
// POST <callback>/packagerCallback/failure as the optional `reason` of
// packagerFailureSchema (src/routes/internal.ts:121-124).
describe('derivePackageFailureReason', () => {
  it('Only ever returns a token the consumer accepts', () => {
    const cases: unknown[] = [
      undefined,
      null,
      '',
      'something went wrong',
      new Error('Packager failed'),
      new Error('Packaging of job abc failed: PARSER_FAILURE'),
      new Error('Failed to fetch job from Encore, got status: 401'),
      Symbol('nope'),
      42,
      { message: 'Unauthorized' }
    ];
    for (const value of cases) {
      expect(PACKAGE_FAILURE_REASONS).toContain(
        derivePackageFailureReason(value)
      );
    }
  });

  it('Classifies media the packaging tool cannot parse as unsupported_media', () => {
    expect(
      derivePackageFailureReason(
        new Error('Packaging of job abc failed: PARSER_FAILURE')
      )
    ).toEqual('unsupported_media');
    expect(
      derivePackageFailureReason(new Error('Error: xyz (parser failure)'))
    ).toEqual('unsupported_media');
    expect(
      derivePackageFailureReason(
        new Error('Packaging of job abc failed: unsupported codec hev1')
      )
    ).toEqual('unsupported_media');
    expect(
      derivePackageFailureReason(new Error('could not parse input file'))
    ).toEqual('unsupported_media');
  });

  it('Classifies a rejected credential as invalid_credentials', () => {
    // src/encorePackager.ts:235-239 throws exactly this text for a 401.
    expect(
      derivePackageFailureReason(
        new Error('Failed to fetch job from Encore, got status: 401')
      )
    ).toEqual('invalid_credentials');
    // @osaas/client-core lib/errors.js: TokenExpiredError / UnauthorizedError.
    expect(
      derivePackageFailureReason(new Error('Service Access Token expired'))
    ).toEqual('invalid_credentials');
    expect(derivePackageFailureReason(new Error('Unauthorized'))).toEqual(
      'invalid_credentials'
    );
    expect(
      derivePackageFailureReason(new Error('invalid access token'))
    ).toEqual('invalid_credentials');
  });

  it('Honours a credential error class whose message says nothing useful', () => {
    class TokenExpiredError extends Error {}
    const err = new TokenExpiredError('');
    err.name = 'TokenExpiredError';

    expect(derivePackageFailureReason(err)).toEqual('invalid_credentials');
  });

  it('Honours an HTTP 401 carried on the error object', () => {
    // @osaas/client-core lib/fetch.js FetchError carries the status as
    // `httpCode`; `status`/`statusCode` are the other spellings seen.
    expect(
      derivePackageFailureReason(
        Object.assign(new Error('request failed'), { httpCode: 401 })
      )
    ).toEqual('invalid_credentials');
    expect(
      derivePackageFailureReason(
        Object.assign(new Error('request failed'), { status: 401 })
      )
    ).toEqual('invalid_credentials');
  });

  it('Does not treat a 403 as a credential failure', () => {
    // A 403 on this path is a storage permission verdict on the media, not a
    // verdict on the token; the consumer excludes it for the same reason.
    expect(
      derivePackageFailureReason(
        Object.assign(new Error('AccessDenied'), { httpCode: 403 })
      )
    ).toEqual('packaging_failed');
  });

  it('Looks down the cause chain', () => {
    const err = new Error('Packaging of job abc failed', {
      cause: new Error('Service Access Token expired')
    });

    expect(derivePackageFailureReason(err)).toEqual('invalid_credentials');
  });

  it('Prefers unsupported_media over invalid_credentials when both match', () => {
    expect(
      derivePackageFailureReason(
        new Error('PARSER_FAILURE after fetch returned 401')
      )
    ).toEqual('unsupported_media');
  });

  it('Defaults to packaging_failed for an unclassifiable failure', () => {
    expect(derivePackageFailureReason(new Error('Packager failed'))).toEqual(
      DEFAULT_PACKAGE_FAILURE_REASON
    );
    expect(DEFAULT_PACKAGE_FAILURE_REASON).toEqual('packaging_failed');
    expect(derivePackageFailureReason(undefined)).toEqual('packaging_failed');
  });

  it('Falls back to the callback message when the error carries no text', () => {
    expect(
      derivePackageFailureReason(
        undefined,
        'Packaging of job abc failed: PARSER_FAILURE'
      )
    ).toEqual('unsupported_media');
  });

  it('Classifies an error whose members throw, instead of propagating', () => {
    const hostile = {
      get message(): string {
        throw new Error('no message for you');
      },
      get name(): string {
        throw new Error('no name for you');
      },
      get cause(): unknown {
        throw new Error('no cause for you');
      },
      toString(): string {
        throw new Error('no string for you');
      }
    };

    expect(derivePackageFailureReason(hostile)).toEqual('packaging_failed');
  });

  it('Terminates on a cyclic cause chain', () => {
    const err: Error & { cause?: unknown } = new Error('Packager failed');
    err.cause = err;

    expect(derivePackageFailureReason(err)).toEqual('packaging_failed');
  });
});

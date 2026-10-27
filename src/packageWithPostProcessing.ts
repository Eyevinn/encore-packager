import { basename, join } from 'node:path';
import { unlink } from 'node:fs/promises';
import {
  cleanup,
  createPackage,
  prepare,
  uploadPackage
} from '@eyevinn/shaka-packager-s3/dist/packager';
import { toUrl } from '@eyevinn/shaka-packager-s3/dist/util';
import { PackageOptions } from '@eyevinn/shaka-packager-s3';
import { trimAacPrimingSamples } from './audioPrimingPostProcessor';

async function removeDownloadedInputs(
  inputs: PackageOptions['inputs'],
  stagingDir: string,
  source?: string
): Promise<void> {
  for (const input of inputs) {
    const localFilename = join(
      stagingDir,
      source || input.filename.includes('://')
        ? basename(input.filename)
        : input.filename
    );
    try {
      await unlink(localFilename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/**
 * Run Shaka in a staging directory, apply the AAC priming workaround to the
 * generated segments, and only then upload the package.
 */
export async function doPackageWithPostProcessing(
  options: PackageOptions
): Promise<void> {
  const stagingDir = await prepare(options.stagingDir);
  try {
    await createPackage({ ...options, stagingDir });
    await trimAacPrimingSamples(stagingDir);

    if (toUrl(options.dest).protocol === 's3:') {
      await removeDownloadedInputs(options.inputs, stagingDir, options.source);
    }
    await uploadPackage(toUrl(options.dest), stagingDir, options.s3EndpointUrl);
  } finally {
    await cleanup(stagingDir);
  }
}

import { mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
// shaka-packager-s3 0.6.3 publishes these helpers from this module but does
// not re-export them from its entrypoint. The dependency is pinned to keep
// this published module path stable until the upstream exports are fixed.
import {
  cleanup,
  createPackage,
  PackageOptions,
  prepare,
  uploadPackage
} from '@eyevinn/shaka-packager-s3/dist/packager';
import { trimAacPrimingSamples } from './audioPrimingPostProcessor';
import { updateAudioManifests } from './manifestPostProcessor';
import type { AudioManifestOptions } from './manifestPostProcessor';

function validatePackageOptions(options: PackageOptions): void {
  const formatOptions = options.packageFormatOptions;
  if (formatOptions?.hlsOnly && formatOptions.dashOnly) {
    throw new Error('Cannot disable both hls and dash');
  }
  if (
    formatOptions?.segmentSingleFileTemplate &&
    !formatOptions.segmentSingleFileTemplate.includes('$KEY$')
  ) {
    throw new Error('segmentSingleFileTemplate must contain $KEY$');
  }
}

async function removeDownloadedInputs(
  inputs: PackageOptions['inputs'],
  outputDir: string
): Promise<void> {
  const outputRoot = resolve(outputDir) + sep;
  for (const input of inputs) {
    // This mirrors the library's download path: only an input URL is reduced
    // to its basename. A relative input with a configured source keeps its
    // relative path below the staging directory.
    const relativeFilename = input.filename.includes('://')
      ? basename(input.filename)
      : input.filename;
    const localFilename = resolve(outputDir, relativeFilename);
    if (!localFilename.startsWith(outputRoot)) {
      console.warn(
        `Skipping removal of input outside the staging directory: ${input.filename}`
      );
      continue;
    }
    try {
      await unlink(localFilename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.warn(`Downloaded input was not found: ${localFilename}`);
        continue;
      }
      throw error;
    }
  }
}

function toDestinationUrl(destination: string): URL {
  return /^[a-z0-9]+:.*/.test(destination)
    ? new URL(destination)
    : pathToFileURL(resolve(destination));
}

/**
 * Package into a temporary local destination, apply the AAC priming
 * workaround, and upload the processed package through shaka-packager-s3's
 * published helper module.
 */
export async function doPackageWithPostProcessing(
  options: PackageOptions
): Promise<void> {
  validatePackageOptions(options);
  const tempParent = options.stagingDir || tmpdir();
  await mkdir(tempParent, { recursive: true });
  const outputDir = await prepare(join(tempParent, 'encore-packager-output'));
  try {
    await createPackage({ ...options, stagingDir: outputDir });
    await removeDownloadedInputs(options.inputs, outputDir);
    const trimResult = await trimAacPrimingSamples(outputDir);
    if (trimResult) {
      const formatOptions = options.packageFormatOptions;
      const manifestOptions: AudioManifestOptions = {
        dashManifestName: formatOptions?.dashManifestName,
        hlsManifestName: formatOptions?.hlsManifestName,
        requireDashManifest: formatOptions?.hlsOnly !== true,
        requireHlsManifest: formatOptions?.dashOnly !== true
      };
      await updateAudioManifests(outputDir, trimResult, manifestOptions);
    }
    await uploadPackage(
      toDestinationUrl(options.dest),
      outputDir,
      options.s3EndpointUrl
    );
  } finally {
    await cleanup(outputDir);
  }
}

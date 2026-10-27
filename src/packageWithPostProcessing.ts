import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { doPackage, PackageOptions } from '@eyevinn/shaka-packager-s3';
import { trimAacPrimingSamples } from './audioPrimingPostProcessor';

async function removeDownloadedInputs(
  inputs: PackageOptions['inputs'],
  outputDir: string,
  source?: string
): Promise<void> {
  for (const input of inputs) {
    const localFilename = join(
      outputDir,
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

async function uploadProcessedPackage(
  outputDir: string,
  destination: string,
  s3EndpointUrl?: string
): Promise<void> {
  if (destination.startsWith('s3:')) {
    const args = ['s3'];
    if (s3EndpointUrl) args.push(`--endpoint-url=${s3EndpointUrl}`);
    args.push('cp', '--recursive', outputDir, destination);
    const result = spawnSync('aws', args, { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(`Upload failed with exit code ${result.status}`);
    }
    return;
  }

  await mkdir(destination, { recursive: true });
  await cp(outputDir, destination, { recursive: true, force: true });
}

/**
 * Package into a temporary local destination, apply the AAC priming
 * workaround, and upload the processed package through the public packager
 * API's normal destination mechanisms.
 */
export async function doPackageWithPostProcessing(
  options: PackageOptions
): Promise<void> {
  const tempParent = options.stagingDir || tmpdir();
  await mkdir(tempParent, { recursive: true });
  const outputDir = await mkdtemp(join(tempParent, 'encore-packager-output-'));
  try {
    await doPackage({ ...options, dest: outputDir });
    await removeDownloadedInputs(options.inputs, outputDir, options.source);
    await trimAacPrimingSamples(outputDir);
    await uploadProcessedPackage(
      outputDir,
      options.dest,
      options.s3EndpointUrl
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const mockPrepare = jest.fn();
const mockCreatePackage = jest.fn();
const mockUploadPackage = jest.fn();
const mockCleanup = jest.fn();
const mockTrimAacPrimingSamples = jest.fn();

jest.mock('@eyevinn/shaka-packager-s3/dist/packager', () => ({
  cleanup: (...args: unknown[]) => mockCleanup(...args),
  createPackage: (...args: unknown[]) => mockCreatePackage(...args),
  prepare: (...args: unknown[]) => mockPrepare(...args),
  uploadPackage: (...args: unknown[]) => mockUploadPackage(...args)
}));

jest.mock('./audioPrimingPostProcessor', () => ({
  trimAacPrimingSamples: (...args: unknown[]) =>
    mockTrimAacPrimingSamples(...args)
}));

import { doPackageWithPostProcessing } from './packageWithPostProcessing';

describe('package post-processing wiring', () => {
  let parentDir: string;
  let uploadedInputWasPresent: boolean;

  beforeEach(async () => {
    parentDir = await mkdtemp(join(tmpdir(), 'encore-package-wrapper-test-'));
    uploadedInputWasPresent = false;
    jest.clearAllMocks();

    mockPrepare.mockImplementation(async (parent: string) => {
      await mkdir(parent, { recursive: true });
      return mkdtemp(join(parent, 'packager-'));
    });
    mockCreatePackage.mockImplementation(
      async (options: { stagingDir: string }) => {
        await mkdir(join(options.stagingDir, 'sub', 'dir'), {
          recursive: true
        });
        await writeFile(
          join(options.stagingDir, 'sub', 'dir', 'input.mp4'),
          'downloaded input'
        );
        await writeFile(join(options.stagingDir, 'manifest.mpd'), 'manifest');
      }
    );
    mockUploadPackage.mockImplementation(
      async (_destination: URL, stagingDir: string) => {
        uploadedInputWasPresent = await access(
          join(stagingDir, 'sub', 'dir', 'input.mp4')
        )
          .then(() => true)
          .catch(() => false);
      }
    );
    mockCleanup.mockImplementation((stagingDir: string) =>
      rm(stagingDir, { recursive: true, force: true })
    );
  });

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true });
  });

  it('stages locally, removes downloaded inputs, and uploads a file destination', async () => {
    const destination = join(parentDir, 'package');

    await doPackageWithPostProcessing({
      inputs: [{ type: 'video', key: 'video', filename: 'sub/dir/input.mp4' }],
      source: 's3://bucket/source',
      dest: destination,
      stagingDir: parentDir
    });

    expect(mockCreatePackage).toHaveBeenCalledWith(
      expect.objectContaining({
        stagingDir: expect.any(String)
      })
    );
    const createOptions = mockCreatePackage.mock.calls[0][0];
    expect(createOptions.dest).toBe(destination);
    expect(uploadedInputWasPresent).toBe(false);
    expect(mockTrimAacPrimingSamples).toHaveBeenCalledWith(
      createOptions.stagingDir
    );
    expect(mockUploadPackage).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: 'file:' }),
      createOptions.stagingDir,
      undefined
    );
    expect(mockCleanup).toHaveBeenCalledWith(createOptions.stagingDir);
  });

  it('uses the library upload primitive for S3 destinations and endpoint overrides', async () => {
    await doPackageWithPostProcessing({
      inputs: [],
      dest: 's3://bucket/package',
      s3EndpointUrl: 'https://s3.example.test',
      stagingDir: parentDir
    });

    expect(mockUploadPackage).toHaveBeenCalledWith(
      new URL('s3://bucket/package'),
      expect.any(String),
      'https://s3.example.test'
    );
  });

  it('does not remove an input path outside the staging directory', async () => {
    const outsidePath = resolve(parentDir, 'outside.mp4');
    await writeFile(outsidePath, 'keep me');
    mockCreatePackage.mockImplementationOnce(
      async (options: { stagingDir: string }) => {
        await writeFile(join(options.stagingDir, 'manifest.mpd'), 'manifest');
      }
    );

    await doPackageWithPostProcessing({
      inputs: [{ type: 'video', key: 'video', filename: '../outside.mp4' }],
      dest: join(parentDir, 'package'),
      stagingDir: parentDir
    });

    await expect(access(outsidePath)).resolves.toBeUndefined();
  });
});

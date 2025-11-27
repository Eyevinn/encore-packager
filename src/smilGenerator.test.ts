import { SmilGenerator } from './smilGenerator';
import { PackagingConfig } from './config';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';

jest.mock('node:child_process');
jest.mock('node:fs/promises');

describe('SmilGenerator uploadToS3', () => {
  const mockConfig: PackagingConfig = {
    outputFolder: '/tmp/output',
    concurrency: 1
  } as PackagingConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    (spawnSync as jest.Mock).mockReturnValue({ status: 0 });
  });

  it('should upload MP4 files first, then SMIL file last', async () => {
    const mockFiles = ['video1.mp4', 'video2.mp4', 'playlist.smil'];
    (readdir as jest.Mock).mockResolvedValue(mockFiles);

    const generator = new SmilGenerator(mockConfig);
    await (generator as any).uploadToS3('/tmp/staging', 's3://bucket/path');

    expect(spawnSync).toHaveBeenCalledTimes(3);

    // First two calls should be for MP4 files, last call for SMIL
    const firstCallArgs = (spawnSync as jest.Mock).mock.calls[0][1];
    const secondCallArgs = (spawnSync as jest.Mock).mock.calls[1][1];
    const thirdCallArgs = (spawnSync as jest.Mock).mock.calls[2][1];

    // Check that MP4 files are uploaded first
    expect(firstCallArgs.join(' ')).toContain('video1.mp4');
    expect(secondCallArgs.join(' ')).toContain('video2.mp4');
    // Check that SMIL file is uploaded last
    expect(thirdCallArgs.join(' ')).toContain('playlist.smil');
  });
});

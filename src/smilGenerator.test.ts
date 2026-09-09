import { SmilGenerator } from './smilGenerator';
import { PackagingConfig } from './config';
import { spawn, spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';

jest.mock('node:child_process');
jest.mock('node:fs/promises');
jest.mock('node:fs');
jest.mock('./util', () => ({
  delay: jest.fn().mockResolvedValue(undefined)
}));

function createFakeCurlProcess(
  exitCode: number,
  stderrOutput = ''
): EventEmitter & { stderr: EventEmitter } {
  const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  proc.stderr = new EventEmitter();
  // Emit asynchronously, mirroring how a real child_process only reports
  // 'close' after the event loop has processed the spawn. downloadFile
  // awaits `mkdir` before curl is even spawned, so listeners are attached
  // on a later tick than the call into downloadFileWithRetry.
  setImmediate(() => {
    if (stderrOutput) {
      proc.stderr.emit('data', Buffer.from(stderrOutput));
    }
    proc.emit('close', exitCode);
  });
  return proc;
}

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

describe('SmilGenerator downloadFileWithRetry', () => {
  const mockConfig: PackagingConfig = {
    outputFolder: '/tmp/output',
    concurrency: 1,
    downloadRetryCount: 3,
    downloadRetryDelaySeconds: 2,
    downloadMaxTimeSeconds: 900,
    downloadAppRetryAttempts: 2
  } as PackagingConfig;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('downloads successfully on the first attempt (no regression)', async () => {
    (spawn as jest.Mock).mockReturnValueOnce(createFakeCurlProcess(0));

    const generator = new SmilGenerator(mockConfig);

    await expect(
      (generator as any).downloadFileWithRetry(
        'https://example.com/video.mp4',
        '/tmp/output/video.mp4',
        undefined,
        undefined
      )
    ).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('recovers and succeeds after one simulated curl failure', async () => {
    (spawn as jest.Mock)
      .mockReturnValueOnce(createFakeCurlProcess(56, 'connection reset'))
      .mockReturnValueOnce(createFakeCurlProcess(0));

    const generator = new SmilGenerator(mockConfig);

    await expect(
      (generator as any).downloadFileWithRetry(
        'https://example.com/video.mp4',
        '/tmp/output/video.mp4',
        undefined,
        undefined
      )
    ).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all app-level retry attempts', async () => {
    const generator = new SmilGenerator(mockConfig);

    (spawn as jest.Mock).mockImplementation(() => createFakeCurlProcess(1));

    await expect(
      (generator as any).downloadFileWithRetry(
        'https://example.com/video.mp4',
        '/tmp/output/video.mp4',
        undefined,
        undefined
      )
    ).rejects.toThrow(/Failed to download/);

    // downloadAppRetryAttempts (2) + the initial attempt = 3 total calls
    expect(spawn).toHaveBeenCalledTimes(3);
  });
});

describe('SmilGenerator isFileAlreadyDownloaded', () => {
  const mockConfig: PackagingConfig = {
    outputFolder: '/tmp/output',
    concurrency: 1
  } as PackagingConfig;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns true when the file exists and its size matches the expected size', () => {
    (existsSync as jest.Mock).mockReturnValue(true);
    (statSync as jest.Mock).mockReturnValue({ size: 1024 });

    const generator = new SmilGenerator(mockConfig);
    expect(
      (generator as any).isFileAlreadyDownloaded('/tmp/output/video.mp4', 1024)
    ).toBe(true);
  });

  it('returns false when the file does not exist', () => {
    (existsSync as jest.Mock).mockReturnValue(false);

    const generator = new SmilGenerator(mockConfig);
    expect(
      (generator as any).isFileAlreadyDownloaded('/tmp/output/video.mp4', 1024)
    ).toBe(false);
  });

  it('returns false when the file exists but its size does not match (partial/corrupt download)', () => {
    (existsSync as jest.Mock).mockReturnValue(true);
    (statSync as jest.Mock).mockReturnValue({ size: 512 });

    const generator = new SmilGenerator(mockConfig);
    expect(
      (generator as any).isFileAlreadyDownloaded('/tmp/output/video.mp4', 1024)
    ).toBe(false);
  });

  it('returns false when the expected size is unknown, even if the file exists', () => {
    (existsSync as jest.Mock).mockReturnValue(true);
    (statSync as jest.Mock).mockReturnValue({ size: 1024 });

    const generator = new SmilGenerator(mockConfig);
    expect(
      (generator as any).isFileAlreadyDownloaded('/tmp/output/video.mp4', 0)
    ).toBe(false);
  });
});

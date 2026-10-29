import { Input } from '@eyevinn/shaka-packager-s3';
// Same helper `uploadPackage()` resolves the destination with, imported from
// the installed package so these tests pin real upstream behaviour rather than
// a local restatement of it (`dist/util.js` lines 15-20).
import { toUrl } from '@eyevinn/shaka-packager-s3/dist/util';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inputSourceFilesInOutput,
  removeInputSourcesFromOutput,
  resolveInputSourceUrls
} from './encorePackager';
import { readConfig } from './config';
import logger from './logger';

// Nothing in this path may shell out any more: removing an input source from an
// `s3:` destination was unreachable work, because `doPackage()` deletes the
// staged sources before it uploads (`dist/packager.js` lines 52-56). Mocking
// the module rather than spying keeps this a guard against it coming back,
// since `spawnSync` itself is not a redefinable property.
jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawnSync: jest.fn()
}));

const encoreInputs: Input[] = [
  {
    type: 'video',
    key: '0_2980',
    filename: '/data/out/job-id/test3_x264_3100.mp4'
  },
  {
    type: 'audio',
    key: '0',
    filename: '/data/out/job-id/test3_STEREO.mp4'
  }
];

describe('resolveInputSourceUrls', () => {
  it('resolves plain Encore output paths against an HTTP source', () => {
    const inputs = resolveInputSourceUrls(
      encoreInputs,
      'https://encore.example.com'
    );
    expect(inputs.map((i) => i.filename)).toEqual([
      'https://encore.example.com/data/out/job-id/test3_x264_3100.mp4',
      'https://encore.example.com/data/out/job-id/test3_STEREO.mp4'
    ]);
    expect(inputs.map((i) => i.key)).toEqual(['0_2980', '0']);
    expect(inputs.map((i) => i.type)).toEqual(['video', 'audio']);
  });

  it('leaves inputs untouched when no source is configured', () => {
    expect(resolveInputSourceUrls(encoreInputs)).toEqual(encoreInputs);
  });

  it('leaves absolute URLs and non-HTTP sources untouched', () => {
    const absolute: Input[] = [
      { type: 'video', key: '0', filename: 'https://host/a/b.mp4' }
    ];
    expect(
      resolveInputSourceUrls(absolute, 'https://encore.example.com')
    ).toEqual(absolute);
    expect(resolveInputSourceUrls(encoreInputs, 's3://bucket/prefix')).toEqual(
      encoreInputs
    );
    expect(resolveInputSourceUrls(encoreInputs, 'not a url')).toEqual(
      encoreInputs
    );
  });
});

describe('inputSourceFilesInOutput', () => {
  it('returns the staged filename for remote sources', () => {
    expect(
      inputSourceFilesInOutput(
        resolveInputSourceUrls(encoreInputs, 'https://encore.example.com')
      )
    ).toEqual(['test3_x264_3100.mp4', 'test3_STEREO.mp4']);
  });

  it('returns nothing for local sources, which are read in place', () => {
    expect(inputSourceFilesInOutput(encoreInputs)).toEqual([]);
    expect(
      inputSourceFilesInOutput([
        { type: 'video', key: '0', filename: 'file:///data/out/a.mp4' }
      ])
    ).toEqual([]);
  });

  it('de-duplicates inputs sharing one source file', () => {
    expect(
      inputSourceFilesInOutput([
        { type: 'video', key: '0', filename: 'https://host/out/a.mp4' },
        { type: 'audio', key: '0', filename: 'https://host/out/a.mp4' }
      ])
    ).toEqual(['a.mp4']);
  });
});

describe('removeInputSourcesFromOutput', () => {
  async function createPackagedOutput(): Promise<string> {
    const dest = await mkdtemp(join(tmpdir(), 'packaged-'));
    await writeFile(join(dest, 'test3_x264_3100.mp4'), 'source rendition');
    await writeFile(join(dest, 'test3_STEREO.mp4'), 'source rendition');
    await writeFile(join(dest, 'index.m3u8'), 'playlist');
    await writeFile(join(dest, 'manifest.mpd'), 'manifest');
    await writeFile(join(dest, 'video-0_2980.m3u8'), 'playlist');
    await mkdir(join(dest, 'video-0_2980'));
    await writeFile(join(dest, 'video-0_2980', 'init.mp4'), 'segment');
    return dest;
  }

  it('leaves only segments, playlists and manifests in a local output', async () => {
    const dest = await createPackagedOutput();
    const inputs = resolveInputSourceUrls(
      encoreInputs,
      'https://encore.example.com'
    );

    await removeInputSourcesFromOutput(dest, inputs);

    expect((await readdir(dest)).sort()).toEqual([
      'index.m3u8',
      'manifest.mpd',
      'video-0_2980',
      'video-0_2980.m3u8'
    ]);
    expect(await readdir(join(dest, 'video-0_2980'))).toEqual(['init.mp4']);
  });

  it('keeps local input sources, which live outside the output', async () => {
    const dest = await createPackagedOutput();

    await removeInputSourcesFromOutput(dest, encoreInputs);

    expect((await readdir(dest)).sort()).toEqual([
      'index.m3u8',
      'manifest.mpd',
      'test3_STEREO.mp4',
      'test3_x264_3100.mp4',
      'video-0_2980',
      'video-0_2980.m3u8'
    ]);
  });

  it('is a no-op when a source file is already gone', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'packaged-'));
    await writeFile(join(dest, 'index.m3u8'), 'playlist');

    await expect(
      removeInputSourcesFromOutput(dest, [
        { type: 'video', key: '0', filename: 'https://host/out/a.mp4' }
      ])
    ).resolves.toBeUndefined();
    expect(await readdir(dest)).toEqual(['index.m3u8']);
  });
});

describe('removeInputSourcesFromOutput destination handling', () => {
  const remoteInputs = resolveInputSourceUrls(
    encoreInputs,
    'https://encore.example.com'
  );

  /**
   * Lay out a destination the way `uploadPackage()` does: it moves the staged
   * files to `join(toUrl(dest).pathname, file)` for a local destination
   * (`node_modules/@eyevinn/shaka-packager-s3/dist/packager.js` lines
   * 180-184), so the package lands under the resolved pathname and not under
   * the raw `dest` string. Returns the directory that actually holds it.
   */
  async function stageUpstreamUpload(dest: string): Promise<string> {
    const uploadDir = toUrl(dest).pathname;
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, 'test3_x264_3100.mp4'), 'source rendition');
    await writeFile(join(uploadDir, 'test3_STEREO.mp4'), 'source rendition');
    await writeFile(join(uploadDir, 'index.m3u8'), 'playlist');
    return uploadDir;
  }

  it('cleans the encoded directory for a destination that needs encoding', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'packaged-'));
    const dest = join(parent, 'out dir');
    const uploadDir = await stageUpstreamUpload(dest);

    // `toUrl()` percent-encodes the space, so the package really sits in a
    // directory whose name contains '%20' — a different path from `dest`.
    expect(uploadDir).toEqual(join(parent, 'out%20dir'));
    expect(uploadDir).not.toEqual(dest);

    await removeInputSourcesFromOutput(dest, remoteInputs);

    expect(await readdir(uploadDir)).toEqual(['index.m3u8']);
  });

  it('cleans a file:// destination, whose raw string is not a path', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'packaged-'));
    const dest = `file://${join(parent, 'out')}`;
    const uploadDir = await stageUpstreamUpload(dest);

    expect(uploadDir).toEqual(join(parent, 'out'));

    await removeInputSourcesFromOutput(dest, remoteInputs);

    expect(await readdir(uploadDir)).toEqual(['index.m3u8']);
  });

  it('does nothing and runs no command for an s3: destination', async () => {
    // `doPackage()` deletes the staged sources before `uploadPackage()` for an
    // `s3:` destination (`dist/packager.js` lines 52-56), so they never become
    // objects and there is nothing for this function to delete remotely.
    const warn = jest.spyOn(logger, 'warn');
    const info = jest.spyOn(logger, 'info');
    const debug = jest.spyOn(logger, 'debug');
    try {
      await expect(
        removeInputSourcesFromOutput('s3://a-bucket/a-prefix', remoteInputs)
      ).resolves.toBeUndefined();

      expect(spawnSync).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('s3:'));
    } finally {
      warn.mockRestore();
      info.mockRestore();
      debug.mockRestore();
    }
  });

  it('warns when an expected input source is not in the output', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'packaged-'));
    const warn = jest.spyOn(logger, 'warn');
    try {
      await removeInputSourcesFromOutput(dest, remoteInputs);

      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringContaining(join(dest, 'test3_x264_3100.mp4')),
        expect.stringContaining(join(dest, 'test3_STEREO.mp4'))
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('includeInputSources config', () => {
  afterEach(() => {
    delete process.env.INCLUDE_INPUT_SOURCES;
  });

  it('excludes input sources by default', () => {
    expect(readConfig().packaging.includeInputSources).toEqual(false);
  });

  it('can be opted into with INCLUDE_INPUT_SOURCES', () => {
    process.env.INCLUDE_INPUT_SOURCES = 'true';
    expect(readConfig().packaging.includeInputSources).toEqual(true);
  });
});

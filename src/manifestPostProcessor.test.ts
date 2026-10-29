import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateAudioManifests } from './manifestPostProcessor';

const result = { primingDuration: 1024, timescale: 48000 };

function mpd(audioOnly: boolean): string {
  const video = audioOnly
    ? ''
    : '<AdaptationSet contentType="video"><Representation><SegmentTemplate duration="2048" timescale="48000" /></Representation></AdaptationSet>';
  return `<MPD mediaPresentationDuration="PT0.085334S"><Period duration="PT0.085334S"><AdaptationSet contentType="audio"><Representation><SegmentTemplate timescale="48000" presentationTimeOffset="1024" duration="2048" media="audio/$Number$.m4s" initialization="audio/init.mp4" /></Representation></AdaptationSet>${video}</Period></MPD>`;
}

const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:1
#EXTINF:0.042667,
audio/1.m4s
#EXTINF:0.042667,
audio/2.m4s
#EXT-X-ENDLIST
`;

describe('audio manifest post-processing', () => {
  it('keeps HLS, MPD segment timing, PTO, and audio-only duration aligned', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'encore-manifest-test-'));
    await mkdir(join(stagingDir, 'audio'));
    await writeFile(join(stagingDir, 'audio', '1.m4s'), 'segment');
    await writeFile(join(stagingDir, 'audio', '2.m4s'), 'segment');
    await writeFile(join(stagingDir, 'audio.m3u8'), playlist);
    await writeFile(join(stagingDir, 'manifest.mpd'), mpd(true));

    await updateAudioManifests(stagingDir, result);

    const updatedHls = await readFile(join(stagingDir, 'audio.m3u8'), 'utf8');
    const updatedMpd = await readFile(join(stagingDir, 'manifest.mpd'), 'utf8');
    expect(updatedHls).toContain('#EXTINF:0.021334,');
    expect(updatedMpd).toContain('presentationTimeOffset="0"');
    expect(updatedMpd).toContain('<S t="0" d="1024"/>');
    expect(updatedMpd).toContain('<S t="1024" d="2048"/>');
    expect(updatedMpd).toContain('mediaPresentationDuration="PT0.064001S"');
    expect(updatedMpd).toContain('duration="PT0.064001S"');
  });

  it('does not shorten whole-presentation duration when video is present', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'encore-manifest-test-'));
    await mkdir(join(stagingDir, 'audio'));
    await writeFile(join(stagingDir, 'audio', '1.m4s'), 'segment');
    await writeFile(join(stagingDir, 'audio', '2.m4s'), 'segment');
    await writeFile(join(stagingDir, 'audio.m3u8'), playlist);
    await writeFile(join(stagingDir, 'manifest.mpd'), mpd(false));

    await updateAudioManifests(stagingDir, result);

    const updatedMpd = await readFile(join(stagingDir, 'manifest.mpd'), 'utf8');
    expect(updatedMpd).toContain('mediaPresentationDuration="PT0.085334S"');
    expect(updatedMpd).toContain('duration="PT0.085334S"');
    expect(updatedMpd).toContain('<S t="0" d="1024"/>');
  });

  it('updates a configured DASH manifest name and rejects a missing expected manifest', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'encore-manifest-test-'));
    await mkdir(join(stagingDir, 'audio'));
    await writeFile(join(stagingDir, 'audio', '1.m4s'), 'segment');
    await writeFile(join(stagingDir, 'audio', '2.m4s'), 'segment');
    await writeFile(join(stagingDir, 'custom.mpd'), mpd(true));

    await updateAudioManifests(stagingDir, result, {
      dashManifestName: 'custom.mpd',
      requireDashManifest: true
    });
    expect(await readFile(join(stagingDir, 'custom.mpd'), 'utf8')).toContain(
      '<S t="0" d="1024"/>'
    );

    await expect(
      updateAudioManifests(stagingDir, result, {
        dashManifestName: 'missing.mpd',
        requireDashManifest: true
      })
    ).rejects.toThrow('Expected DASH manifest was not generated');
  });
});

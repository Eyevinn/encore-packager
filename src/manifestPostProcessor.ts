import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AacPrimingPostProcessingResult } from './audioPrimingPostProcessor';

type HlsManifestUpdate = {
  content: string;
  segmentDurations: number[];
};

const AUDIO_PLAYLIST = 'audio.m3u8';
const DASH_MANIFEST = 'manifest.mpd';

export type AudioManifestOptions = {
  dashManifestName?: string;
  hlsManifestName?: string;
  requireDashManifest?: boolean;
  requireHlsManifest?: boolean;
};

function formatSeconds(value: number): string {
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function readAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(
    attributes
  );
  return match?.[2];
}

function writeAttribute(
  attributes: string,
  name: string,
  value: string
): string {
  const expression = new RegExp(`(\\b${name}\\s*=\\s*)(["'])(.*?)\\2`, 'i');
  if (expression.test(attributes)) {
    return attributes.replace(expression, `$1"${value}"`);
  }
  return `${attributes} ${name}="${value}"`;
}

function subtractPresentationDuration(
  content: string,
  name: string,
  deltaSeconds: number
): string {
  return content.replace(
    new RegExp(
      `(\\b${name}\\b\\s*=\\s*["'])PT([0-9]+(?:\\.[0-9]+)?)S(["'])`,
      'i'
    ),
    (_match, prefix: string, duration: string, suffix: string) => {
      const next = Number(duration) - deltaSeconds;
      if (next <= 0) {
        throw new Error(`Cannot reduce ${name} below zero`);
      }
      return `${prefix}PT${formatSeconds(next)}S${suffix}`;
    }
  );
}

function updateHlsManifest(
  content: string,
  primingDuration: number,
  timescale: number
): HlsManifestUpdate | undefined {
  const deltaSeconds = primingDuration / timescale;
  const lines = content.split('\n');
  const segmentDurations: number[] = [];
  let firstExtinfIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '');
    const match = /^#EXTINF:([0-9]+(?:\.[0-9]+)?)(,.*)?$/.exec(line);
    if (!match) continue;
    const duration = Number(match[1]);
    if (firstExtinfIndex === -1) firstExtinfIndex = index;
    segmentDurations.push(duration);
  }

  if (firstExtinfIndex === -1 || segmentDurations.length === 0) {
    return undefined;
  }

  const firstDuration = segmentDurations[0] - deltaSeconds;
  if (firstDuration <= 0) {
    throw new Error('Cannot reduce the first HLS audio segment below zero');
  }
  segmentDurations[0] = firstDuration;
  const originalLine = lines[firstExtinfIndex].replace(/\r$/, '');
  const suffix = lines[firstExtinfIndex].endsWith('\r') ? '\r' : '';
  const comma = originalLine.match(/^#EXTINF:[^,]*(,.*)?$/)?.[1] || ',';
  lines[firstExtinfIndex] = `#EXTINF:${formatSeconds(
    firstDuration
  )}${comma}${suffix}`;

  return { content: lines.join('\n'), segmentDurations };
}

function findAudioAdaptations(content: string): string[] {
  return (
    content.match(/<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/gi) || []
  );
}

function isAudioAdaptation(adaptation: string): boolean {
  const openingTag = /^\s*<AdaptationSet\b[^>]*>/i.exec(adaptation)?.[0] || '';
  return (
    /\bcontentType\s*=\s*["']audio["']/i.test(openingTag) ||
    /\bmimeType\s*=\s*["']audio\//i.test(openingTag)
  );
}

function makeSegmentTimeline(durations: number[]): string {
  let presentationTime = 0;
  const entries = durations.map((duration) => {
    const entry = `<S t="${presentationTime}" d="${duration}"/>`;
    presentationTime += duration;
    return entry;
  });
  return `<SegmentTimeline>${entries.join('')}</SegmentTimeline>`;
}

function updateSegmentTemplate(
  template: string,
  segmentDurations: number[],
  primingDuration: number,
  timescale: number
): string {
  const selfClosing = /^<SegmentTemplate\b([^>]*?)\/>$/i.exec(template);
  const withTimeline =
    /^<SegmentTemplate\b([^>]*)>([\s\S]*)<\/SegmentTemplate>$/i.exec(template);
  if (!selfClosing && !withTimeline) return template;
  if (selfClosing && segmentDurations.length === 0) return template;

  let attributes = selfClosing?.[1] || withTimeline?.[1] || '';
  const templateTimescale =
    Number(readAttribute(attributes, 'timescale')) || timescale;
  const presentationTimeOffset = readAttribute(
    attributes,
    'presentationTimeOffset'
  );
  if (presentationTimeOffset !== undefined) {
    const nextOffset = Math.max(
      0,
      Number(presentationTimeOffset) - primingDuration
    );
    if (!Number.isSafeInteger(nextOffset)) {
      throw new Error('Unsupported audio presentationTimeOffset');
    }
    attributes = writeAttribute(
      attributes,
      'presentationTimeOffset',
      nextOffset.toString()
    );
  }

  if (withTimeline) {
    const body = withTimeline[2];
    const firstSegment = /<S\b([^>]*?)(\/?)>/i.exec(body);
    if (!firstSegment) return template;
    const firstDuration = Number(readAttribute(firstSegment[1], 'd'));
    const durationDelta = Math.round(
      (primingDuration * templateTimescale) / timescale
    );
    const nextDuration = firstDuration - durationDelta;
    if (!Number.isSafeInteger(nextDuration) || nextDuration <= 0) {
      throw new Error('Cannot reduce the first MPD audio segment below zero');
    }
    const updatedFirst = `<S${writeAttribute(
      firstSegment[1],
      'd',
      nextDuration.toString()
    )}${firstSegment[2]}>`;
    return `<SegmentTemplate${attributes}>${body.replace(
      firstSegment[0],
      updatedFirst
    )}</SegmentTemplate>`;
  }

  const mediaDurations = segmentDurations.map((duration, index) => {
    const value = Math.round(duration * templateTimescale);
    if (index === 0) return value - primingDuration;
    return value;
  });
  if (mediaDurations.some((duration) => duration <= 0)) {
    throw new Error('Cannot reduce the first MPD audio segment below zero');
  }
  attributes = attributes.replace(/\s+duration\s*=\s*["'][^"']*["']/i, '');
  return `<SegmentTemplate${attributes}>${makeSegmentTimeline(
    mediaDurations
  )}</SegmentTemplate>`;
}

function updateMpdManifest(
  content: string,
  segmentDurations: number[],
  result: AacPrimingPostProcessingResult
): string {
  const adaptations = findAudioAdaptations(content);
  const audioAdaptations = adaptations.filter(isAudioAdaptation);
  if (audioAdaptations.length === 0) return content;

  let updated = content;
  let templateUpdated = false;
  for (const adaptation of audioAdaptations) {
    const replaced = adaptation.replace(
      /<SegmentTemplate\b[^>]*(?:\/>|>[\s\S]*?<\/SegmentTemplate>)/gi,
      (template) => {
        const updatedTemplate = updateSegmentTemplate(
          template,
          segmentDurations,
          result.primingDuration,
          result.timescale
        );
        templateUpdated ||= updatedTemplate !== template;
        return updatedTemplate;
      }
    );
    updated = updated.replace(adaptation, replaced);
  }

  if (!templateUpdated) return updated;

  // MPD presentation duration is the duration of the whole presentation. It
  // only changes when the package contains audio alone; with video present,
  // the video timeline remains the presentation-duration authority.
  if (adaptations.length === 1 && audioAdaptations.length === 1) {
    const deltaSeconds = result.primingDuration / result.timescale;
    updated = subtractPresentationDuration(
      updated,
      'mediaPresentationDuration',
      deltaSeconds
    );
    updated = subtractPresentationDuration(updated, 'duration', deltaSeconds);
  }
  return updated;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readRequired(path: string, label: string): Promise<string> {
  const content = await readOptional(path);
  if (content === undefined) {
    throw new Error(`Expected ${label} was not generated: ${path}`);
  }
  return content;
}

async function inferSegmentDurations(
  stagingDir: string,
  mpdContent: string,
  timescale: number
): Promise<number[]> {
  const audioDir = join(stagingDir, 'audio');
  const segmentCount = (await readdir(audioDir)).filter((file) =>
    /^\d+\.m4s$/.test(file)
  ).length;
  const audioAdaptation =
    findAudioAdaptations(mpdContent).find(isAudioAdaptation);
  const durationMatch = audioAdaptation
    ? /<SegmentTemplate\b[^>]*\bduration\s*=\s*["'](\d+)["']/i.exec(
        audioAdaptation
      )
    : undefined;
  const templateAttributes = audioAdaptation?.match(
    /<SegmentTemplate\b([^>]*)/i
  )?.[1];
  const templateTimescale = templateAttributes
    ? Number(readAttribute(templateAttributes, 'timescale')) || timescale
    : timescale;
  const duration = durationMatch
    ? Number(durationMatch[1]) / templateTimescale
    : 0;
  if (segmentCount === 0 || duration <= 0) return [];
  return Array.from({ length: segmentCount }, () => duration);
}

export async function updateAudioManifests(
  stagingDir: string,
  result: AacPrimingPostProcessingResult,
  options: AudioManifestOptions = {}
): Promise<void> {
  const hlsPath = join(stagingDir, AUDIO_PLAYLIST);
  const hlsMasterPath = join(
    stagingDir,
    options.hlsManifestName || 'index.m3u8'
  );
  const mpdPath = join(stagingDir, options.dashManifestName || DASH_MANIFEST);
  if (options.requireHlsManifest) {
    await readRequired(hlsMasterPath, 'HLS master manifest');
  }
  const originalHls = options.requireHlsManifest
    ? await readRequired(hlsPath, 'HLS audio manifest')
    : await readOptional(hlsPath);
  const originalMpd = options.requireDashManifest
    ? await readRequired(mpdPath, 'DASH manifest')
    : await readOptional(mpdPath);
  if (!originalHls && !originalMpd) return;

  const hlsUpdate = originalHls
    ? updateHlsManifest(originalHls, result.primingDuration, result.timescale)
    : undefined;
  const mpdSegmentDurations = originalMpd
    ? await inferSegmentDurations(stagingDir, originalMpd, result.timescale)
    : [];
  const segmentDurations =
    mpdSegmentDurations.length > 0
      ? mpdSegmentDurations
      : hlsUpdate?.segmentDurations || [];
  const updatedMpd = originalMpd
    ? updateMpdManifest(originalMpd, segmentDurations, result)
    : undefined;

  if (options.requireHlsManifest && !hlsUpdate) {
    throw new Error(
      `Expected HLS audio manifest has no media segments: ${hlsPath}`
    );
  }
  if (
    options.requireDashManifest &&
    updatedMpd !== undefined &&
    updatedMpd === originalMpd
  ) {
    throw new Error(
      `DASH manifest has no updatable audio timeline: ${mpdPath}`
    );
  }

  if (hlsUpdate) await writeFile(hlsPath, hlsUpdate.content);
  if (updatedMpd !== undefined) await writeFile(mpdPath, updatedMpd);
}

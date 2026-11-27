import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import logger from './logger';

const TRUN_DATA_OFFSET_PRESENT = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS_PRESENT = 0x000004;
const TRUN_SAMPLE_DURATION_PRESENT = 0x000100;
const TRUN_SAMPLE_SIZE_PRESENT = 0x000200;
const TRUN_SAMPLE_FLAGS_PRESENT = 0x000400;
const TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT = 0x000800;
const TFHD_BASE_DATA_OFFSET_PRESENT = 0x000001;
const TFHD_DEFAULT_SAMPLE_FLAGS_PRESENT = 0x000020;
const TFHD_DEFAULT_SAMPLE_SIZE_PRESENT = 0x000010;
const TFHD_DEFAULT_BASE_IS_MOOF_PRESENT = 0x020000;

type Mp4Box = {
  type: string;
  start: number;
  size: number;
  headerSize: number;
  payload: Buffer;
  raw: Buffer;
};

type TrunSample = {
  duration?: number;
  size?: number;
  flags?: number;
  compositionTimeOffset?: number;
};

type ParsedTrun = {
  version: number;
  flags: number;
  dataOffset?: number;
  firstSampleFlags?: number;
  samples: TrunSample[];
};

type ParsedTfhd = {
  trackId: number;
  baseDataOffsetPresent: boolean;
  defaultBaseIsMoof: boolean;
  defaultSampleDuration?: number;
  defaultSampleSize?: number;
  defaultSampleFlags?: number;
};

type AudioInitInfo = {
  buffer: Buffer;
  audioTrackId: number;
  primingDuration: number;
  timescale: number;
  defaultSampleDuration?: number;
  defaultSampleFlags?: number;
};

export type AacPrimingPostProcessingResult = {
  primingDuration: number;
  timescale: number;
};

function parseBoxes(buffer: Buffer, start = 0, end = buffer.length): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = start;

  while (offset < end) {
    if (end - offset < 8) {
      throw new Error(`Invalid MP4 box header at offset ${offset}`);
    }

    const declaredSize = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    let size = declaredSize;

    if (declaredSize === 1) {
      if (end - offset < 16) {
        throw new Error(`Invalid extended MP4 box header for ${type}`);
      }
      const extendedSize = Number(buffer.readBigUInt64BE(offset + 8));
      if (!Number.isSafeInteger(extendedSize)) {
        throw new Error(`Unsupported oversized MP4 box ${type}`);
      }
      size = extendedSize;
      headerSize = 16;
    } else if (declaredSize === 0) {
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) {
      throw new Error(`Invalid MP4 box size for ${type}`);
    }

    boxes.push({
      type,
      start: offset,
      size,
      headerSize,
      payload: buffer.subarray(offset + headerSize, offset + size),
      raw: buffer.subarray(offset, offset + size)
    });
    offset += size;
  }

  return boxes;
}

function encodeBox(type: string, payload: Buffer): Buffer {
  const size = payload.length + 8;
  if (size > 0xffffffff) {
    const result = Buffer.alloc(16 + payload.length);
    result.writeUInt32BE(1, 0);
    result.write(type, 4, 4, 'ascii');
    result.writeBigUInt64BE(BigInt(result.length), 8);
    payload.copy(result, 16);
    return result;
  }

  const result = Buffer.alloc(size);
  result.writeUInt32BE(size, 0);
  result.write(type, 4, 4, 'ascii');
  payload.copy(result, 8);
  return result;
}

function serializeBox(box: Mp4Box): Buffer {
  return box.raw;
}

function replaceChildren(box: Mp4Box, children: Buffer[]): Buffer {
  return encodeBox(box.type, Buffer.concat(children));
}

function fullBoxVersion(payload: Buffer): number {
  if (payload.length < 4) {
    throw new Error('Invalid full MP4 box');
  }
  return payload[0];
}

function fullBoxFlags(payload: Buffer): number {
  if (payload.length < 4) {
    throw new Error('Invalid full MP4 box');
  }
  return payload.readUIntBE(1, 3);
}

function readTfhd(box: Mp4Box): ParsedTfhd {
  const flags = fullBoxFlags(box.payload);
  if (box.payload.length < 8) {
    throw new Error('Invalid tfhd box');
  }

  let offset = 8;
  const result: ParsedTfhd = {
    trackId: box.payload.readUInt32BE(4),
    baseDataOffsetPresent: Boolean(flags & TFHD_BASE_DATA_OFFSET_PRESENT),
    defaultBaseIsMoof: Boolean(flags & TFHD_DEFAULT_BASE_IS_MOOF_PRESENT)
  };

  if (flags & TFHD_BASE_DATA_OFFSET_PRESENT) {
    if (box.payload.length < offset + 8) {
      throw new Error('Invalid tfhd base data offset');
    }
    offset += 8;
  }
  if (flags & 0x000002) offset += 4;
  if (flags & 0x000008) {
    if (box.payload.length < offset + 4) {
      throw new Error('Invalid tfhd default sample duration');
    }
    result.defaultSampleDuration = box.payload.readUInt32BE(offset);
    offset += 4;
  }
  if (flags & TFHD_DEFAULT_SAMPLE_SIZE_PRESENT) {
    if (box.payload.length < offset + 4) {
      throw new Error('Invalid tfhd default sample size');
    }
    result.defaultSampleSize = box.payload.readUInt32BE(offset);
    offset += 4;
  }
  if (flags & TFHD_DEFAULT_SAMPLE_FLAGS_PRESENT) {
    if (box.payload.length < offset + 4) {
      throw new Error('Invalid tfhd default sample flags');
    }
    result.defaultSampleFlags = box.payload.readUInt32BE(offset);
  }

  return result;
}

function readTrun(box: Mp4Box): ParsedTrun {
  const version = fullBoxVersion(box.payload);
  const flags = fullBoxFlags(box.payload);
  if (box.payload.length < 8) {
    throw new Error('Invalid trun box');
  }

  let offset = 8;
  const sampleCount = box.payload.readUInt32BE(4);
  const result: ParsedTrun = { version, flags, samples: [] };

  if (flags & TRUN_DATA_OFFSET_PRESENT) {
    if (box.payload.length < offset + 4) {
      throw new Error('Invalid trun data offset');
    }
    result.dataOffset = box.payload.readInt32BE(offset);
    offset += 4;
  }
  if (flags & TRUN_FIRST_SAMPLE_FLAGS_PRESENT) {
    if (box.payload.length < offset + 4) {
      throw new Error('Invalid trun first sample flags');
    }
    result.firstSampleFlags = box.payload.readUInt32BE(offset);
    offset += 4;
  }

  for (let index = 0; index < sampleCount; index += 1) {
    const sample: TrunSample = {};
    if (flags & TRUN_SAMPLE_DURATION_PRESENT) {
      sample.duration = readUInt32(box.payload, offset, 'trun sample duration');
      offset += 4;
    }
    if (flags & TRUN_SAMPLE_SIZE_PRESENT) {
      sample.size = readUInt32(box.payload, offset, 'trun sample size');
      offset += 4;
    }
    if (flags & TRUN_SAMPLE_FLAGS_PRESENT) {
      sample.flags = readUInt32(box.payload, offset, 'trun sample flags');
      offset += 4;
    }
    if (flags & TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT) {
      sample.compositionTimeOffset =
        version === 1
          ? readInt32(box.payload, offset, 'trun composition offset')
          : readUInt32(box.payload, offset, 'trun composition offset');
      offset += 4;
    }
    result.samples.push(sample);
  }

  if (offset !== box.payload.length) {
    throw new Error('Unexpected data in trun box');
  }
  return result;
}

function writeUInt32(value: number, label: string): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value, 0);
  return result;
}

function writeInt32(value: number, label: string): Buffer {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  const result = Buffer.alloc(4);
  result.writeInt32BE(value, 0);
  return result;
}

function readUInt32(buffer: Buffer, offset: number, label: string): number {
  if (buffer.length < offset + 4) throw new Error(`Invalid ${label}`);
  return buffer.readUInt32BE(offset);
}

function readInt32(buffer: Buffer, offset: number, label: string): number {
  if (buffer.length < offset + 4) throw new Error(`Invalid ${label}`);
  return buffer.readInt32BE(offset);
}

function writeTrun(parsed: ParsedTrun): Buffer {
  const chunks: Buffer[] = [];
  const versionAndFlags = Buffer.alloc(4);
  versionAndFlags[0] = parsed.version;
  versionAndFlags.writeUIntBE(parsed.flags, 1, 3);
  chunks.push(
    versionAndFlags,
    writeUInt32(parsed.samples.length, 'trun sample count')
  );

  if (parsed.flags & TRUN_DATA_OFFSET_PRESENT) {
    chunks.push(writeInt32(parsed.dataOffset || 0, 'trun data offset'));
  }
  if (parsed.flags & TRUN_FIRST_SAMPLE_FLAGS_PRESENT) {
    chunks.push(
      writeUInt32(parsed.firstSampleFlags || 0, 'trun first sample flags')
    );
  }

  for (const sample of parsed.samples) {
    if (parsed.flags & TRUN_SAMPLE_DURATION_PRESENT) {
      chunks.push(writeUInt32(sample.duration || 0, 'trun sample duration'));
    }
    if (parsed.flags & TRUN_SAMPLE_SIZE_PRESENT) {
      chunks.push(writeUInt32(sample.size || 0, 'trun sample size'));
    }
    if (parsed.flags & TRUN_SAMPLE_FLAGS_PRESENT) {
      chunks.push(writeUInt32(sample.flags || 0, 'trun sample flags'));
    }
    if (parsed.flags & TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT) {
      chunks.push(
        parsed.version === 1
          ? writeInt32(
              sample.compositionTimeOffset || 0,
              'trun composition offset'
            )
          : writeUInt32(
              sample.compositionTimeOffset || 0,
              'trun composition offset'
            )
      );
    }
  }

  return encodeBox('trun', Buffer.concat(chunks));
}

function findChild(box: Mp4Box, type: string): Mp4Box | undefined {
  return parseBoxes(box.payload).find((child) => child.type === type);
}

function readTrackId(trak: Mp4Box): number | undefined {
  const tkhd = findChild(trak, 'tkhd');
  if (!tkhd) return undefined;
  const version = fullBoxVersion(tkhd.payload);
  const offset = version === 1 ? 20 : 12;
  if (tkhd.payload.length < offset + 4) return undefined;
  return tkhd.payload.readUInt32BE(offset);
}

function readTrackTimescale(trak: Mp4Box): number | undefined {
  const mdia = findChild(trak, 'mdia');
  const mdhd = mdia && findChild(mdia, 'mdhd');
  if (!mdhd) return undefined;
  const version = fullBoxVersion(mdhd.payload);
  const offset = version === 1 ? 20 : 12;
  if (mdhd.payload.length < offset + 4) return undefined;
  return mdhd.payload.readUInt32BE(offset);
}

function readPrimingDuration(trak: Mp4Box): number | undefined {
  const edts = findChild(trak, 'edts');
  const elst = edts && findChild(edts, 'elst');
  if (!elst) return undefined;

  const version = fullBoxVersion(elst.payload);
  if (elst.payload.length < 8) throw new Error('Invalid elst box');
  const entryCount = elst.payload.readUInt32BE(4);
  let offset = 8;
  const entrySize = version === 1 ? 20 : 12;
  for (let index = 0; index < entryCount; index += 1) {
    if (elst.payload.length < offset + entrySize) {
      throw new Error('Invalid elst entry');
    }
    const mediaTime =
      version === 1
        ? Number(elst.payload.readBigInt64BE(offset + 8))
        : elst.payload.readInt32BE(offset + 4);
    if (mediaTime > 0) return mediaTime;
    offset += entrySize;
  }
  return undefined;
}

function readAudioSampleEntry(trak: Mp4Box): {
  type?: string;
  encrypted: boolean;
} {
  const mdia = findChild(trak, 'mdia');
  const minf = mdia && findChild(mdia, 'minf');
  const stbl = minf && findChild(minf, 'stbl');
  const stsd = stbl && findChild(stbl, 'stsd');
  if (!stsd || stsd.payload.length < 12) {
    return { encrypted: false };
  }

  const entries = parseBoxes(stsd.payload, 8);
  const entry = entries[0];
  if (!entry) return { encrypted: false };

  const encrypted =
    entry.type === 'enca' ||
    (entry.payload.length >= 28 &&
      parseBoxes(entry.payload, 28).some((child) => child.type === 'sinf'));
  return { type: entry.type, encrypted };
}

function readTrexDefaultSampleDuration(
  moov: Mp4Box,
  trackId: number
): { duration?: number; flags?: number } {
  const mvex = findChild(moov, 'mvex');
  if (!mvex) return {};
  const trex = parseBoxes(mvex.payload).find((child) => {
    if (child.type !== 'trex' || child.payload.length < 16) return false;
    return child.payload.readUInt32BE(4) === trackId;
  });
  if (!trex || trex.payload.length < 16) return {};
  return {
    duration: trex.payload.readUInt32BE(12),
    flags: trex.payload.length >= 24 ? trex.payload.readUInt32BE(20) : undefined
  };
}

function isAudioTrack(trak: Mp4Box): boolean {
  const mdia = findChild(trak, 'mdia');
  const hdlr = mdia && findChild(mdia, 'hdlr');
  return Boolean(
    hdlr &&
      hdlr.payload.length >= 12 &&
      hdlr.payload.toString('ascii', 8, 12) === 'soun'
  );
}

function inspectAndRemoveAudioEditList(
  buffer: Buffer
): AudioInitInfo | undefined {
  const topLevel = parseBoxes(buffer);
  const moov = topLevel.find((box) => box.type === 'moov');
  if (!moov) throw new Error('MP4 init segment has no moov box');

  let audioTrackId: number | undefined;
  let primingDuration: number | undefined;
  let timescale: number | undefined;
  let audioSampleEntry: { type?: string; encrypted: boolean } | undefined;
  const moovChildren = parseBoxes(moov.payload);
  const transformedMoovChildren = moovChildren.map((child) => {
    if (child.type !== 'trak' || !isAudioTrack(child))
      return serializeBox(child);

    const trackId = readTrackId(child);
    if (trackId === undefined) {
      throw new Error('Audio track has no track ID');
    }
    audioTrackId = trackId;
    primingDuration = readPrimingDuration(child);
    timescale = readTrackTimescale(child);
    audioSampleEntry = readAudioSampleEntry(child);

    const trakChildren = parseBoxes(child.payload).filter(
      (trakChild) => trakChild.type !== 'edts'
    );
    return replaceChildren(
      child,
      trakChildren.map((trakChild) => serializeBox(trakChild))
    );
  });

  if (audioTrackId === undefined || !audioSampleEntry) return undefined;
  if (audioSampleEntry.encrypted || audioSampleEntry.type !== 'mp4a') {
    return undefined;
  }
  if (primingDuration === undefined || timescale === undefined)
    return undefined;

  const transformedMoov = replaceChildren(moov, transformedMoovChildren);
  const transformedTopLevel = topLevel.map((box) =>
    box === moov ? transformedMoov : serializeBox(box)
  );
  const trexDefaults = readTrexDefaultSampleDuration(moov, audioTrackId);
  return {
    buffer: Buffer.concat(transformedTopLevel),
    audioTrackId,
    primingDuration,
    timescale,
    defaultSampleDuration: trexDefaults.duration,
    defaultSampleFlags: trexDefaults.flags
  };
}

function rewriteAudioTrun(
  moof: Mp4Box,
  audioTrackId: number,
  removeFirstSample: boolean,
  defaultSampleDuration?: number,
  defaultSampleFlags?: number
): {
  buffer: Buffer;
  removedSampleSize?: number;
  removedSampleDuration?: number;
  dataOffset?: number;
} {
  let removed = false;
  let removedSampleSize: number | undefined;
  let removedSampleDuration: number | undefined;
  let originalDataOffset: number | undefined;

  const transformedTraf = parseBoxes(moof.payload).map((child) => {
    if (child.type !== 'traf') return serializeBox(child);
    const trafChildren = parseBoxes(child.payload);
    const tfhdBox = trafChildren.find((trafChild) => trafChild.type === 'tfhd');
    if (!tfhdBox || readTfhd(tfhdBox).trackId !== audioTrackId) {
      return serializeBox(child);
    }

    const tfhd = readTfhd(tfhdBox);
    if (tfhd.baseDataOffsetPresent || !tfhd.defaultBaseIsMoof) {
      throw new Error(
        'Cannot trim audio without default-base-is-moof and no base_data_offset'
      );
    }
    const transformedTrun = trafChildren.map((trafChild) => {
      if (trafChild.type !== 'trun' || removed || !removeFirstSample) {
        return serializeBox(trafChild);
      }

      const trun = readTrun(trafChild);
      if (trun.samples.length === 0) return serializeBox(trafChild);

      const firstSample = trun.samples[0];
      removedSampleSize = firstSample.size ?? tfhd.defaultSampleSize;
      removedSampleDuration =
        firstSample.duration ??
        tfhd.defaultSampleDuration ??
        defaultSampleDuration;
      if (removedSampleSize === undefined) {
        throw new Error('Cannot determine the first AAC sample size');
      }
      if (removedSampleSize === 0) {
        throw new Error('The first AAC sample has zero size');
      }
      if (removedSampleDuration === undefined || removedSampleDuration === 0) {
        throw new Error('Cannot determine the first AAC sample duration');
      }
      if (trun.dataOffset === undefined) {
        throw new Error('Cannot trim an audio trun without data_offset');
      }

      if (trun.flags & TRUN_FIRST_SAMPLE_FLAGS_PRESENT) {
        const defaultFlags = tfhd.defaultSampleFlags ?? defaultSampleFlags ?? 0;
        if (
          !(trun.flags & TRUN_SAMPLE_FLAGS_PRESENT) &&
          trun.firstSampleFlags !== defaultFlags
        ) {
          throw new Error(
            'Cannot trim an audio trun with first-sample flags that differ from the default'
          );
        }
      }

      originalDataOffset = trun.dataOffset;
      trun.samples.shift();
      trun.flags &= ~TRUN_FIRST_SAMPLE_FLAGS_PRESENT;
      trun.firstSampleFlags = undefined;
      removed = true;
      return writeTrun(trun);
    });

    return replaceChildren(child, transformedTrun);
  });

  if (removeFirstSample && !removed) {
    throw new Error('Audio segment 1 has no AAC samples to trim');
  }

  return {
    buffer: replaceChildren(moof, transformedTraf),
    removedSampleSize,
    removedSampleDuration,
    dataOffset: originalDataOffset
  };
}

function adjustTrunDataOffsets(moofBuffer: Buffer, delta: number): Buffer {
  const moof = parseBoxes(moofBuffer)[0];
  const transformedTraf = parseBoxes(moof.payload).map((child) => {
    if (child.type !== 'traf') return serializeBox(child);
    const transformed = parseBoxes(child.payload).map((trafChild) => {
      if (trafChild.type !== 'trun') return serializeBox(trafChild);
      const trun = readTrun(trafChild);
      if (trun.dataOffset !== undefined) trun.dataOffset += delta;
      return trun.dataOffset === undefined
        ? serializeBox(trafChild)
        : writeTrun(trun);
    });
    return replaceChildren(child, transformed);
  });
  return replaceChildren(moof, transformedTraf);
}

function sidxReferenceOffset(box: Mp4Box): number {
  const version = fullBoxVersion(box.payload);
  let offset = 12;
  offset += version === 1 ? 16 : 8;
  offset += 2;
  if (box.payload.length < offset + 2) {
    throw new Error('Invalid sidx box');
  }
  return offset + 2;
}

function adjustFirstSidx(
  box: Mp4Box,
  referencedSizeDelta: number,
  durationDelta: number
): Buffer {
  const offset = sidxReferenceOffset(box);

  const referenceCount = box.payload.readUInt16BE(offset - 2);
  if (referenceCount === 0 || box.payload.length < offset + 12) {
    logger.warn('Skipping sidx adjustment: no complete media reference found');
    return box.raw;
  }

  const reference = box.payload.readUInt32BE(offset);
  if (reference & 0x80000000) {
    logger.warn('Skipping sidx adjustment: first reference is not media data');
    return box.raw;
  }

  const referencedSize = reference & 0x7fffffff;
  const nextReferencedSize = referencedSize + referencedSizeDelta;
  if (nextReferencedSize < 0 || nextReferencedSize > 0x7fffffff) {
    throw new Error('Invalid adjusted sidx values');
  }
  const duration = box.payload.readUInt32BE(offset + 4);
  const nextDuration = duration - durationDelta;
  if (nextDuration < 0 || nextDuration > 0xffffffff) {
    throw new Error('Invalid adjusted sidx duration');
  }

  const payload = Buffer.from(box.payload);
  payload.writeUInt32BE(nextReferencedSize, offset);
  payload.writeUInt32BE(nextDuration, offset + 4);
  return encodeBox('sidx', payload);
}

function shiftSidxEarliestPresentationTime(box: Mp4Box, shift: number): Buffer {
  const version = fullBoxVersion(box.payload);
  const earliestOffset = 12;
  const current =
    version === 1
      ? Number(box.payload.readBigUInt64BE(earliestOffset))
      : box.payload.readUInt32BE(earliestOffset);
  if (!Number.isSafeInteger(current) || current < shift) {
    throw new Error('Cannot move sidx earliest presentation time before zero');
  }

  const next = current - shift;
  const payload = Buffer.from(box.payload);
  if (version === 1) {
    payload.writeBigUInt64BE(BigInt(next), earliestOffset);
  } else {
    payload.writeUInt32BE(next, earliestOffset);
  }
  return encodeBox('sidx', payload);
}

function shiftAudioTfdt(
  buffer: Buffer,
  audioTrackId: number,
  shift: number
): Buffer {
  const topLevel = parseBoxes(buffer);
  const moof = topLevel.find((box) => box.type === 'moof');
  if (!moof) throw new Error('Audio media segment has no moof box');

  let shifted = false;
  const transformedTraf = parseBoxes(moof.payload).map((child) => {
    if (child.type !== 'traf') return serializeBox(child);
    const trafChildren = parseBoxes(child.payload);
    const tfhdBox = trafChildren.find((trafChild) => trafChild.type === 'tfhd');
    if (!tfhdBox || readTfhd(tfhdBox).trackId !== audioTrackId) {
      return serializeBox(child);
    }

    const transformed = trafChildren.map((trafChild) => {
      if (trafChild.type !== 'tfdt') return serializeBox(trafChild);
      const version = fullBoxVersion(trafChild.payload);
      const offset = 4;
      const current =
        version === 1
          ? Number(trafChild.payload.readBigUInt64BE(offset))
          : trafChild.payload.readUInt32BE(offset);
      if (current < shift) {
        throw new Error('Cannot move audio tfdt before zero');
      }
      const next = current - shift;
      const payload = Buffer.from(trafChild.payload);
      if (version === 1) {
        payload.writeBigUInt64BE(BigInt(next), offset);
      } else {
        payload.writeUInt32BE(next, offset);
      }
      shifted = true;
      return encodeBox('tfdt', payload);
    });
    return replaceChildren(child, transformed);
  });

  if (!shifted) throw new Error('Audio media segment has no tfdt box');
  const transformedMoof = replaceChildren(moof, transformedTraf);
  let shiftedSidx = false;
  return Buffer.concat(
    topLevel.map((box) => {
      if (box === moof) return transformedMoof;
      if (box.type === 'sidx' && !shiftedSidx) {
        shiftedSidx = true;
        return shiftSidxEarliestPresentationTime(box, shift);
      }
      return serializeBox(box);
    })
  );
}

function trimFirstAudioSample(
  buffer: Buffer,
  audioTrackId: number,
  defaultSampleDuration?: number,
  defaultSampleFlags?: number
): { buffer: Buffer; removedSampleDuration: number } {
  const topLevel = parseBoxes(buffer);
  const moof = topLevel.find((box) => box.type === 'moof');
  if (!moof) throw new Error('Audio media segment has no moof box');
  const trafs = parseBoxes(moof.payload).filter(
    (child) => child.type === 'traf'
  );
  if (trafs.length > 1) {
    throw new Error(
      'Audio priming post-processing only supports single-track moof boxes'
    );
  }

  const audioTraf = parseBoxes(moof.payload).find((child) => {
    if (child.type !== 'traf') return false;
    const tfhd = findChild(child, 'tfhd');
    return Boolean(tfhd && readTfhd(tfhd).trackId === audioTrackId);
  });
  if (audioTraf && findChild(audioTraf, 'senc')) {
    throw new Error('Encrypted audio segments are not supported');
  }

  const rewritten = rewriteAudioTrun(
    moof,
    audioTrackId,
    true,
    defaultSampleDuration,
    defaultSampleFlags
  );
  if (
    rewritten.removedSampleSize === undefined ||
    rewritten.removedSampleDuration === undefined ||
    rewritten.dataOffset === undefined
  ) {
    throw new Error('Failed to identify the first AAC sample');
  }
  const removedSampleSize = rewritten.removedSampleSize;
  const removedSampleDuration = rewritten.removedSampleDuration;
  const dataOffset = rewritten.dataOffset;

  const oldMoofSize = moof.size;
  const newMoofSize = rewritten.buffer.length;
  const delta = newMoofSize - oldMoofSize;
  const transformedMoof = adjustTrunDataOffsets(rewritten.buffer, delta);
  const sampleAbsoluteOffset = moof.start + dataOffset;
  let removedFromMdat = false;
  let adjustedSidx = false;

  const transformedTopLevel = topLevel.map((box) => {
    if (box === moof) return transformedMoof;
    if (box.type === 'sidx' && !adjustedSidx) {
      adjustedSidx = true;
      return adjustFirstSidx(
        box,
        delta - removedSampleSize,
        removedSampleDuration
      );
    }
    if (box.type !== 'mdat') return serializeBox(box);

    const sampleOffsetInMdat =
      sampleAbsoluteOffset - box.start - box.headerSize;
    if (
      !removedFromMdat &&
      sampleOffsetInMdat >= 0 &&
      sampleOffsetInMdat + removedSampleSize <= box.payload.length
    ) {
      removedFromMdat = true;
      const payload = Buffer.concat([
        box.payload.subarray(0, sampleOffsetInMdat),
        box.payload.subarray(sampleOffsetInMdat + removedSampleSize)
      ]);
      return encodeBox('mdat', payload);
    }
    return serializeBox(box);
  });

  if (!removedFromMdat) {
    throw new Error('The first AAC sample is not present in an mdat box');
  }
  return {
    buffer: Buffer.concat(transformedTopLevel),
    removedSampleDuration
  };
}

function segmentNumber(filename: string): number {
  const match = /^(\d+)\.m4s$/.exec(filename);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

async function processAudioRendition(
  audioDir: string
): Promise<AacPrimingPostProcessingResult | undefined> {
  const initPath = join(audioDir, 'init.mp4');
  try {
    await stat(initPath);
  } catch {
    return undefined;
  }

  try {
    const init = await inspectAndRemoveAudioEditList(await readFile(initPath));
    if (!init) {
      logger.warn(
        `Skipping AAC priming post-processing for ${audioDir}: not an eligible clear AAC rendition`
      );
      return undefined;
    }

    const segmentFiles = (await readdir(audioDir)).filter((file) =>
      file.endsWith('.m4s')
    );
    segmentFiles.sort(
      (left, right) => segmentNumber(left) - segmentNumber(right)
    );
    if (segmentFiles.length === 0) {
      logger.warn(
        `Skipping AAC priming post-processing for ${audioDir}: no segmented audio files`
      );
      return undefined;
    }

    const firstSegment = join(audioDir, segmentFiles[0]);
    const trimmedFirstSegment = trimFirstAudioSample(
      await readFile(firstSegment),
      init.audioTrackId,
      init.defaultSampleDuration,
      init.defaultSampleFlags
    );
    if (trimmedFirstSegment.removedSampleDuration !== init.primingDuration) {
      logger.warn(
        `Skipping AAC priming post-processing for ${audioDir}: edit-list duration ${init.primingDuration} does not match first sample duration ${trimmedFirstSegment.removedSampleDuration}`
      );
      return undefined;
    }

    // Keep the compute phase separate from the write phase. Buffering the
    // transformed segments ensures a parse/layout failure cannot partially
    // modify this rendition; the wrapper's disposable staging directory also
    // makes the all-at-once upload safe for the final destination.
    const laterSegments = [] as { path: string; buffer: Buffer }[];
    for (const segment of segmentFiles.slice(1)) {
      const path = join(audioDir, segment);
      laterSegments.push({
        path,
        buffer: shiftAudioTfdt(
          await readFile(path),
          init.audioTrackId,
          trimmedFirstSegment.removedSampleDuration
        )
      });
    }

    try {
      await writeFile(initPath, init.buffer);
      await writeFile(firstSegment, trimmedFirstSegment.buffer);
      for (const segment of laterSegments) {
        await writeFile(segment.path, segment.buffer);
      }
    } catch (error) {
      throw new Error(
        `AAC priming post-processing write failed for ${audioDir}: ${
          (error as Error).message
        }`,
        { cause: error }
      );
    }
    logger.info(`Applied AAC priming post-processing to ${audioDir}`);
    return {
      primingDuration: trimmedFirstSegment.removedSampleDuration,
      timescale: init.timescale
    };
  } catch (error) {
    if (
      (error as Error).message.startsWith(
        'AAC priming post-processing write failed'
      )
    ) {
      throw error;
    }
    logger.warn(
      `Skipping AAC priming post-processing for ${audioDir}: ${
        (error as Error).message
      }`
    );
    return undefined;
  }
}

export async function trimAacPrimingSamples(
  stagingDir: string
): Promise<AacPrimingPostProcessingResult | undefined> {
  const entries = await readdir(stagingDir, { withFileTypes: true });
  const audioRendition = entries.find(
    (entry) => entry.isDirectory() && entry.name === 'audio'
  );

  if (audioRendition) {
    const result = await processAudioRendition(
      join(stagingDir, audioRendition.name)
    );
    if (result) return result;
  }

  logger.warn(
    'AAC priming post-processing was enabled, but no eligible segmented AAC rendition was found; encrypted or segmentSingleFile output is left unchanged'
  );
  return undefined;
}

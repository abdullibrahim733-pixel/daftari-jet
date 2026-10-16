/**
 * Synthetic voice notes for local development.
 *
 * A short valid WAV is generated so the review screen has real audio to play
 * with browser controls. The spoken text is stored in a private sidecar file
 * that only the mock speech adapter reads; it is never written to logs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveDataDir } from '@/server/db/client';
import { localMediaStorage } from '../storage/local-storage-adapter';
import type { StoredObject } from '../storage/port';

export type SyntheticFailure =
  | 'unsupported_media'
  | 'no_speech'
  | 'provider_outage'
  | 'too_long';

export type SyntheticMetadata = {
  transcript: string;
  language: string;
  durationSeconds: number;
  noiseDb: number;
  scriptedFailure?: SyntheticFailure;
};

function sidecarPath(objectKey: string): string {
  return path.join(resolveDataDir(), 'media', `${objectKey}.meta.json`);
}

const sampleRate = 16_000;

function encodeWav(durationSeconds: number): Buffer {
  const sampleCount = Math.max(1, Math.floor(sampleRate * durationSeconds));
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / sampleRate;
    // Gentle two-tone chime so playback is audibly real without being noise.
    const sample = Math.sin(2 * Math.PI * 440 * t) * 0.18 + Math.sin(2 * Math.PI * 660 * t) * 0.08;
    buffer.writeInt16LE(Math.round(sample * 32_767), 44 + index * 2);
  }
  return buffer;
}

export async function createSyntheticVoiceNote(input: {
  businessId: string;
  transcript: string;
  language: string;
  durationSeconds?: number;
  noiseDb?: number;
  scriptedFailure?: SyntheticFailure;
}): Promise<StoredObject & { durationSeconds: number }> {
  const durationSeconds = input.durationSeconds ?? 6;
  const bytes = encodeWav(durationSeconds);
  const stored = await localMediaStorage.putObject({
    businessId: input.businessId,
    bytes,
    mediaType: 'audio/wav',
  });
  const metadata: SyntheticMetadata = {
    transcript: input.transcript,
    language: input.language,
    durationSeconds,
    noiseDb: input.noiseDb ?? 4,
    ...(input.scriptedFailure ? { scriptedFailure: input.scriptedFailure } : {}),
  };
  mkdirSync(path.dirname(sidecarPath(stored.objectKey)), { recursive: true });
  writeFileSync(sidecarPath(stored.objectKey), JSON.stringify(metadata), { mode: 0o600 });
  return { ...stored, durationSeconds };
}

export function readSyntheticMetadata(objectKey: string): SyntheticMetadata | null {
  const target = sidecarPath(objectKey);
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, 'utf8')) as SyntheticMetadata;
  } catch {
    return null;
  }
}

export function syntheticChecksum(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
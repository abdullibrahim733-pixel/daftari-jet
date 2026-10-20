'use client';

/**
 * In-app voice recorder.
 *
 * Records audio in the browser, keeps it locally for playback, then uploads it
 * once to `/api/v1/capture/voice`. The recording is stored privately and turned
 * into a reviewable draft; this page only captures and confirms receipt.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createTranslator } from '@/lib/localization';

const t = createTranslator('en');

type Phase = 'idle' | 'recording' | 'ready' | 'saving' | 'saved';

function preferredMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = Math.max(0, Math.floor(total % 60));
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function recordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

export default function RecordPage() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [failedSave, setFailedSave] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const durationRef = useRef(0);
  const blobRef = useRef<Blob | null>(null);
  const captureIdRef = useRef('');

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    },
    [audioUrl],
  );

  const start = useCallback(async () => {
    if (!recordingSupported()) {
      setError(t('record.unsupported'));
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        clearTimer();
        releaseStream();
        const duration = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
        durationRef.current = duration;
        setElapsed(duration);
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        blobRef.current = blob;
        captureIdRef.current = crypto.randomUUID();
        setAudioUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return URL.createObjectURL(blob);
        });
        setPhase('ready');
      };
      recorder.start();
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setElapsed(0);
      setPhase('recording');
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 500);
    } catch {
      releaseStream();
      setPhase('idle');
      setError(t('record.micDenied'));
    }
  }, [clearTimer, releaseStream]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
      recorderRef.current = null;
    }
  }, []);

  const save = useCallback(async () => {
    const blob = blobRef.current;
    if (!blob) return;
    setPhase('saving');
    setError(null);
    setFailedSave(false);
    try {
      const form = new FormData();
      form.append('captureId', captureIdRef.current);
      form.append('durationSeconds', String(durationRef.current));
      form.append('audio', blob, 'recording.webm');
      const response = await fetch('/api/v1/capture/voice', { method: 'POST', body: form });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? t('record.failed'));
      }
      setPhase('saved');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('record.failed'));
      setFailedSave(true);
      setPhase('ready');
    }
  }, []);

  const reset = useCallback(() => {
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    blobRef.current = null;
    captureIdRef.current = '';
    durationRef.current = 0;
    setElapsed(0);
    setError(null);
    setFailedSave(false);
    setPhase('idle');
  }, []);

  return (
    <div className="record-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t('dashboard.workspace')}</p>
          <h1>{t('record.title')}</h1>
          <p className="page-subtitle">{t('record.subtitle')}</p>
        </div>
      </header>

      {error && (
        <div className="notice notice-error" role="alert">
          <span>{error}</span>
          {failedSave && <span>{t('record.retryHint')}</span>}
        </div>
      )}

      <section className="panel">
        {phase === 'saved' ? (
          <div className="record-result">
            <h2>{t('record.saved')}</h2>
            <p>{t('record.savedBody')}</p>
            <div className="record-actions">
              <Link className="button button-primary" href="/review">{t('record.openReview')}</Link>
              <button className="button button-secondary" type="button" onClick={reset}>
                {t('record.again')}
              </button>
            </div>
          </div>
        ) : (
          <div className="record-controls">
            <p className="record-hint">{t('record.hint')}</p>
            <p className="record-timer" aria-live="polite">{formatSeconds(elapsed)}</p>

            {audioUrl && (
              <audio className="record-playback" controls src={audioUrl} aria-label={t('record.playback')} />
            )}

            <div className="record-actions">
              {phase === 'idle' && (
                <button className="button button-primary" type="button" onClick={() => void start()}>
                  {t('record.start')}
                </button>
              )}
              {phase === 'recording' && (
                <button className="button button-danger" type="button" onClick={stop}>
                  {t('record.stop')}
                </button>
              )}
              {phase === 'ready' && (
                <button className="button button-primary" type="button" onClick={() => void save()}>
                  {failedSave ? t('record.retry') : t('record.save')}
                </button>
              )}
              {phase === 'saving' && (
                <button className="button button-primary" type="button" disabled>
                  {t('record.saving')}
                </button>
              )}
              {(phase === 'ready' || phase === 'recording') && (
                <button className="button button-secondary" type="button" onClick={reset} disabled={phase === 'recording'}>
                  {t('record.again')}
                </button>
              )}
            </div>
            <p className="record-hint">{t('record.privacy')}</p>
          </div>
        )}
      </section>
    </div>
  );
}

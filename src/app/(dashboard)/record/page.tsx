'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createTranslator } from '@/lib/localization';

const t = createTranslator('sw');

type Phase = 'idle' | 'requesting_permission' | 'recording' | 'ready' | 'uploading' | 'processing' | 'reviewing';

type Proposal = {
  id: string;
  sourceEventId: string;
  recordType: string | null;
  amountMinor: number | null;
  currency: string | null;
  occurredAtHint: string | null;
  customerNameHint: string | null;
  ambiguityNote: string | null;
  missingFields: string[];
};

type ProposalResponse = { data?: { proposals?: Proposal[] } };
type CaptureResponse = { data?: { sourceEventId?: string }; error?: { message?: string } };

function preferredMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

function formatSeconds(total: number): string {
  const seconds = Math.max(0, Math.floor(total));
  if (seconds >= 3600) {
    return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function recordingSupported(): boolean {
  return typeof navigator !== 'undefined'
    && typeof MediaRecorder !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia);
}

function formatAmount(minor: number, currency: string | null): string {
  return new Intl.NumberFormat('sw-TZ', {
    style: 'currency',
    currency: currency || 'TZS',
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('sw-TZ', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function recordTypeLabel(value: string | null): string {
  if (!value) return t('record.field.missing');
  const labels: Record<string, string> = {
    sale: 'Mauzo', expense: 'Matumizi', debt: 'Deni', debt_payment: 'Malipo ya deni',
    stock_movement: 'Mabadiliko ya bidhaa', note: 'Dokezo', refund: 'Marejesho', transfer: 'Uhamisho',
  };
  return labels[value] ?? value.replaceAll('_', ' ');
}

function AudioVisualizer({ stream, active }: { stream: MediaStream | null; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    let frame = 0;
    let audioContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let samples: Uint8Array<ArrayBuffer> | null = null;
    let smoothedLevel = 0;
    let width = 0;
    let height = 0;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = bounds.width;
      height = bounds.height;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    resize();
    window.addEventListener('resize', resize);

    if (active && stream && typeof window.AudioContext !== 'undefined') {
      try {
        audioContext = new AudioContext();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        audioContext.createMediaStreamSource(stream).connect(analyser);
        samples = new Uint8Array(analyser.fftSize);
      } catch {
        analyser = null;
      }
    }

    const draw = () => {
      if (!width || !height) return;
      const centerX = width / 2;
      const centerY = height / 2;
      const baseRadius = Math.min(width, height) * 0.31;
      let level = 0;

      if (active && analyser && samples && !reducedMotion) {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const amplitude = (sample - 128) / 128;
          sum += amplitude * amplitude;
        }
        level = Math.min(1, Math.sqrt(sum / samples.length) * 5.5);
        const smoothing = level > smoothedLevel ? 0.28 : 0.12;
        smoothedLevel += (level - smoothedLevel) * smoothing;
      } else {
        smoothedLevel *= 0.88;
      }

      context.clearRect(0, 0, width, height);
      context.save();
      context.translate(centerX, centerY);
      context.strokeStyle = 'rgba(158, 179, 200, 0.20)';
      context.lineWidth = 1;
      for (const radius of [baseRadius * 0.76, baseRadius, baseRadius * 1.24]) {
        context.beginPath();
        context.arc(0, 0, radius + smoothedLevel * 6, 0, Math.PI * 2);
        context.stroke();
      }

      const barCount = 52;
      context.lineCap = 'round';
      for (let index = 0; index < barCount; index += 1) {
        const angle = (index / barCount) * Math.PI * 2;
        const variation = active && !reducedMotion
          ? ((index % 4) / 4) * smoothedLevel * 34 + smoothedLevel * 14
          : 2;
        const inner = baseRadius * 1.1;
        const outer = inner + 4 + variation;
        context.beginPath();
        context.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
        context.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
        context.strokeStyle = index % 3 === 0 ? '#FF8A00' : 'rgba(255, 138, 0, 0.58)';
        context.lineWidth = index % 3 === 0 ? 3 : 2;
        context.stroke();
      }
      context.restore();

      if (!reducedMotion && active) frame = window.requestAnimationFrame(draw);
    };

    draw();
    return () => {
      window.removeEventListener('resize', resize);
      window.cancelAnimationFrame(frame);
      if (audioContext) void audioContext.close();
    };
  }, [active, stream]);

  return (
    <div className={`voice-visualizer${active ? ' voice-visualizer-active' : ''}`} aria-hidden="true">
      <canvas ref={canvasRef} className="voice-visualizer__canvas" />
      <div className="voice-visualizer__core">
        <svg viewBox="0 0 32 32" focusable="false">
          <rect x="11" y="4" width="10" height="17" rx="5" />
          <path d="M7 15v1a9 9 0 0 0 18 0v-1M16 25v4m-5 0h10" />
        </svg>
      </div>
    </div>
  );
}

export default function RecordPage() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [processingIssue, setProcessingIssue] = useState(false);
  const [processingDelayed, setProcessingDelayed] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [sourceEventId, setSourceEventId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const durationRef = useRef(0);
  const blobRef = useRef<Blob | null>(null);
  const captureIdRef = useRef('');
  const stopRef = useRef<() => void>(() => {});
  const discardOnStopRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const clearRecording = useCallback(() => {
    clearTimer();
    releaseStream();
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    blobRef.current = null;
    captureIdRef.current = '';
    durationRef.current = 0;
    setElapsed(0);
  }, [clearTimer, releaseStream]);

  useEffect(() => () => {
    clearTimer();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl, clearTimer]);

  useEffect(() => {
    // The browser keeps the recording blob only in memory until the upload is
    // accepted. Warn before a refresh or tab close can silently discard it.
    if (!['recording', 'ready', 'uploading'].includes(phase)) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = t('record.leaveWarning');
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [phase]);

  const start = useCallback(async () => {
    if (!recordingSupported()) {
      setError(t('record.unsupported'));
      return;
    }
    setError(null);
    setPhase('requesting_permission');
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = mediaStream;
      setStream(mediaStream);
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      discardOnStopRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        clearTimer();
        releaseStream();
        if (discardOnStopRef.current) {
          discardOnStopRef.current = false;
          chunksRef.current = [];
          durationRef.current = 0;
          setElapsed(0);
          setPhase('idle');
          return;
        }
        durationRef.current = Math.max(1, Math.round((performance.now() - startedAtRef.current) / 1000));
        setElapsed(durationRef.current);
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
      recorder.onerror = () => {
        clearTimer();
        releaseStream();
        setError(t('record.captureError'));
        setPhase('idle');
      };
      recorder.start();
      recorderRef.current = recorder;
      startedAtRef.current = performance.now();
      setElapsed(0);
      setPhase('recording');
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((performance.now() - startedAtRef.current) / 1000));
      }, 250);
    } catch (captureError) {
      releaseStream();
      setPhase('idle');
      const name = captureError instanceof DOMException ? captureError.name : '';
      setError(name === 'NotFoundError' || name === 'DevicesNotFoundError'
        ? t('record.noMicrophone')
        : t('record.micDenied'));
    }
  }, [clearTimer, releaseStream]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
      recorderRef.current = null;
    }
  }, []);

  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const handleVisibility = () => {
      if (!document.hidden) return;
      setError(t('record.interrupted'));
      stopRef.current();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [phase]);

  const cancel = useCallback(() => {
    if (phase === 'recording') {
      if (!window.confirm(t('record.cancelConfirm'))) return;
      discardOnStopRef.current = true;
      stop();
      return;
    }
    if (blobRef.current && !window.confirm(t('record.discardConfirm'))) return;
    clearRecording();
    setError(null);
    setPhase('idle');
  }, [clearRecording, phase, stop]);

  const upload = useCallback(async () => {
    const blob = blobRef.current;
    if (!blob) return;
    if (!navigator.onLine) {
      setError(t('record.offline'));
      return;
    }
    setPhase('uploading');
    setError(null);
    try {
      const form = new FormData();
      form.append('captureId', captureIdRef.current);
      form.append('durationSeconds', String(durationRef.current));
      const mediaType = blob.type || 'audio/webm';
      const extension = mediaType.includes('mp4') || mediaType.includes('m4a') ? 'm4a' : mediaType.includes('ogg') ? 'ogg' : 'webm';
      form.append('audio', blob, `recording.${extension}`);
      const response = await fetch('/api/v1/capture/voice', { method: 'POST', body: form });
      const body = await response.json() as CaptureResponse;
      if (!response.ok) throw new Error(body.error?.message ?? t('record.failed'));
      const id = body.data?.sourceEventId;
      if (!id) throw new Error(t('record.responseInvalid'));
      setSourceEventId(id);
      setProcessingIssue(false);
      setProcessingDelayed(false);
      setPhase('processing');
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t('record.failed'));
      setPhase('ready');
    }
  }, []);

  useEffect(() => {
    if (phase !== 'processing' || !sourceEventId) return;
    let cancelled = false;
    const wait = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

    async function checkProposal() {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (attempt > 0) await wait(1500);
        if (cancelled) return;
        try {
          const response = await fetch('/api/v1/review/proposals?limit=100&states=needs_review,needs_details,duplicate');
          if (!response.ok) throw new Error(t('record.processingStatusError'));
          const body = await response.json() as ProposalResponse;
          const match = body.data?.proposals?.find((item) => item.sourceEventId === sourceEventId);
          if (match) {
            setProposal(match);
            setPhase('reviewing');
            return;
          }
        } catch {
          if (!cancelled) setProcessingIssue(true);
          return;
        }
      }
      if (!cancelled) setProcessingDelayed(true);
    }

    void checkProposal();
    return () => { cancelled = true; };
  }, [phase, pollVersion, sourceEventId]);

  const reset = useCallback(() => {
    clearRecording();
    setError(null);
    setProcessingIssue(false);
    setProcessingDelayed(false);
    setSourceEventId(null);
    setProposal(null);
    setPhase('idle');
  }, [clearRecording]);

  const statusKey = phase === 'requesting_permission' ? 'record.status.permission'
    : phase === 'recording' ? 'record.status.recording'
      : phase === 'ready' ? 'record.status.ready'
        : phase === 'uploading' ? 'record.status.uploading'
          : phase === 'processing' ? 'record.status.processing'
            : phase === 'reviewing' ? 'record.status.review'
              : 'record.status.idle';
  const helperKey = phase === 'requesting_permission' ? 'record.helper.permission'
    : phase === 'recording' ? 'record.helper.recording'
      : phase === 'ready' ? 'record.helper.ready'
        : phase === 'uploading' ? 'record.helper.uploading'
          : phase === 'processing' ? 'record.helper.processing'
            : phase === 'reviewing' ? 'record.helper.review'
              : 'record.helper.idle';

  return (
    <div className="voice-recording">
      <section className="voice-recording__content" aria-labelledby="record-screen-title">
        <div className="voice-recording__intro">
          <p className="voice-recording__eyebrow">Sema, SAHL inaandika.</p>
          <h1 id="record-screen-title">{t('record.title')}</h1>
          <p>{t('record.subtitle')}</p>
        </div>

        <AudioVisualizer stream={stream} active={phase === 'recording'} />

        <div className="voice-recording__status">
          <p className={`voice-recording__state${phase === 'recording' ? ' is-recording' : ''}`} role="status" aria-live="polite" aria-atomic="true">
            <span className="voice-recording__status-dot" aria-hidden="true" />
            {t(statusKey)}
          </p>
          <p className="voice-recording__timer">{formatSeconds(elapsed)}</p>
          <p className="voice-recording__helper">{t(helperKey)}</p>
        </div>

        {error && <p className="voice-recording__error" role="alert">{error}</p>}
        {phase === 'ready' && audioUrl && (
          <audio className="voice-recording__playback" controls src={audioUrl} aria-label={t('record.playback')} />
        )}

        {phase === 'processing' && (
          <div className="voice-recording__processing" role="status">
            <span className="voice-recording__spinner" aria-hidden="true" />
            <p>{processingIssue ? t('record.processingStatusError') : processingDelayed ? t('record.processingDelayed') : t('record.processingBody')}</p>
            {(processingIssue || processingDelayed) && (
              <button className="voice-recording__text-button" type="button" onClick={() => { setProcessingIssue(false); setProcessingDelayed(false); setPollVersion((version) => version + 1); }}>
                {t('record.checkAgain')}
              </button>
            )}
            <Link className="voice-recording__text-button" href="/review">{t('record.openReview')}</Link>
          </div>
        )}

        {phase === 'reviewing' && proposal && (
          <section className="voice-summary" aria-labelledby="voice-summary-title">
            <header className="voice-summary__header">
              <div>
                <p className="voice-summary__eyebrow">{t('record.draftBadge')}</p>
                <h2 id="voice-summary-title">{t('record.summaryTitle')}</h2>
              </div>
              <span className="voice-summary__badge">{t('record.draftBadge')}</span>
            </header>
            <dl className="voice-summary__fields">
              <div><dt>{t('record.field.type')}</dt><dd>{recordTypeLabel(proposal.recordType)}</dd></div>
              {proposal.amountMinor !== null && <div><dt>{t('record.field.amount')}</dt><dd>{formatAmount(proposal.amountMinor, proposal.currency)}</dd></div>}
              {proposal.customerNameHint && <div><dt>{t('record.field.counterparty')}</dt><dd>{proposal.customerNameHint}</dd></div>}
              {proposal.occurredAtHint && <div><dt>{t('record.field.date')}</dt><dd>{formatDate(proposal.occurredAtHint)}</dd></div>}
              {proposal.missingFields.length > 0 && <div className="voice-summary__uncertain"><dt>{t('record.field.needsReview')}</dt><dd>{proposal.missingFields.map((field) => field === 'recordType' ? t('record.field.type') : field === 'amountMinor' ? t('record.field.amount') : field.replaceAll('_', ' ')).join(', ')}</dd></div>}
              {proposal.ambiguityNote && <div className="voice-summary__note"><dt>{t('record.field.note')}</dt><dd>{proposal.ambiguityNote}</dd></div>}
            </dl>
            <p className="voice-summary__notice">{t('record.reviewNotice')}</p>
            <div className="voice-summary__actions">
              <Link className="voice-button voice-button--primary" href={`/review/${proposal.id}`}>{t('record.openProposal')}</Link>
              <button className="voice-button voice-button--secondary" type="button" onClick={reset}>{t('record.again')}</button>
            </div>
          </section>
        )}

        <div className="voice-recording__actions">
          {phase === 'idle' && (
            <button className="voice-record-button" type="button" onClick={() => void start()} aria-label={t('record.start')}>
              <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="11" y="4" width="10" height="17" rx="5" /><path d="M7 15v1a9 9 0 0 0 18 0v-1M16 25v4m-5 0h10" /></svg>
            </button>
          )}
          {phase === 'requesting_permission' && <button className="voice-record-button" type="button" disabled aria-label={t('record.requesting')}><span className="voice-recording__spinner" /></button>}
          {phase === 'recording' && <button className="voice-record-button voice-record-button--stop" type="button" onClick={stop} aria-label={t('record.stop')}><span /></button>}
          {phase === 'ready' && <button className="voice-button voice-button--primary" type="button" onClick={() => void upload()}>{t('record.sendForReview')}</button>}
          {phase === 'uploading' && <button className="voice-button voice-button--primary" type="button" disabled><span className="voice-recording__spinner" />{t('record.uploading')}</button>}
          {(phase === 'ready' || phase === 'recording') && <button className="voice-button voice-button--secondary" type="button" onClick={cancel}>{t(phase === 'recording' ? 'record.cancel' : 'record.again')}</button>}
          {phase === 'processing' && <button className="voice-button voice-button--secondary" type="button" onClick={reset}>{t('record.again')}</button>}
        </div>
        <p className="voice-recording__privacy">{t('record.privacy')}</p>
      </section>
    </div>
  );
}

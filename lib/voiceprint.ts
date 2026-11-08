"use client";

/**
 * Best-effort on-device speaker check.
 *
 * We never store audio: only a handful of averaged acoustic features are kept
 * locally (pitch, brightness/spectral centroid and their spreads). Matching is a
 * heuristic — good enough to keep a TV or a nearby voice from driving the
 * assistant, not a security boundary. Everything runs on the device.
 */

export interface VoiceProfile {
  pitch: number;
  centroid: number;
  pitchSpread: number;
  centroidSpread: number;
  samples: number;
  createdAt: number;
}

export interface VoiceSample {
  pitch: number;
  centroid: number;
  rms: number;
}

const PROFILE_KEY = "brian.voiceprofile.v1";
const MIN_RMS = 0.012;

export function loadProfile(): VoiceProfile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as VoiceProfile;
    if (typeof parsed.pitch !== "number" || typeof parsed.centroid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveProfile(profile: VoiceProfile): void {
  try {
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    /* storage may be full or blocked */
  }
}

export function clearProfile(): void {
  try {
    window.localStorage.removeItem(PROFILE_KEY);
  } catch {
    /* ignore */
  }
}

/** Autocorrelation pitch estimate over one analyser frame. */
function estimatePitch(frame: Float32Array, sampleRate: number): number {
  let rms = 0;
  for (let i = 0; i < frame.length; i++) rms += frame[i] * frame[i];
  rms = Math.sqrt(rms / frame.length);
  if (rms < MIN_RMS) return 0;

  const minLag = Math.floor(sampleRate / 1000); // 1000 Hz ceiling
  const maxLag = Math.floor(sampleRate / 70); // 70 Hz floor
  let bestLag = -1;
  let bestCorr = 0;

  for (let lag = minLag; lag < maxLag && lag < frame.length; lag++) {
    let corr = 0;
    for (let i = 0; i < frame.length - lag; i++) {
      corr += frame[i] * frame[i + lag];
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  if (bestLag <= 0) return 0;
  return sampleRate / bestLag;
}

function estimateCentroid(freq: Float32Array, sampleRate: number, fftSize: number): number {
  let weighted = 0;
  let total = 0;
  const binHz = sampleRate / fftSize;
  for (let i = 1; i < freq.length; i++) {
    // dBFS -> linear magnitude
    const magnitude = Math.pow(10, freq[i] / 20);
    weighted += magnitude * i * binHz;
    total += magnitude;
  }
  return total > 0 ? weighted / total : 0;
}

/** Continuously measures the live microphone while the assistant listens. */
export class VoiceSampler {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private timer: number | null = null;
  private frames: VoiceSample[] = [];
  private last: VoiceSample | null = null;
  private readonly stream: MediaStream;

  constructor(stream: MediaStream) {
    this.stream = stream;
  }

  async start(): Promise<void> {
    if (this.ctx) return;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    await ctx.resume().catch(() => undefined);
    const source = ctx.createMediaStreamSource(this.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);

    this.ctx = ctx;
    this.source = source;
    this.analyser = analyser;

    const timeData = new Float32Array(analyser.fftSize);
    const freqData = new Float32Array(analyser.frequencyBinCount);

    this.timer = window.setInterval(() => {
      if (!this.analyser || !this.ctx) return;
      this.analyser.getFloatTimeDomainData(timeData);
      this.analyser.getFloatFrequencyData(freqData);

      let rms = 0;
      for (let i = 0; i < timeData.length; i++) rms += timeData[i] * timeData[i];
      rms = Math.sqrt(rms / timeData.length);

      const pitch = estimatePitch(timeData, this.ctx.sampleRate);
      if (pitch > 0 && rms >= MIN_RMS) {
        const centroid = estimateCentroid(freqData, this.ctx.sampleRate, this.analyser.fftSize);
        this.last = { pitch, centroid, rms };
        if (this.frames.length < 400) this.frames.push(this.last);
      }
    }, 100);
  }

  get latest(): VoiceSample | null {
    return this.last;
  }

  /** Average of the voiced frames captured so far. */
  snapshot(): VoiceProfile | null {
    if (this.frames.length < 6) return null;
    const pitches = this.frames.map((f) => f.pitch).filter((p) => p > 60 && p < 500);
    const centroids = this.frames.map((f) => f.centroid).filter((c) => c > 100 && c < 6000);
    if (pitches.length < 4 || centroids.length < 4) return null;

    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    const spread = (values: number[]) => {
      const m = mean(values);
      return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
    };

    return {
      pitch: mean(pitches),
      centroid: mean(centroids),
      pitchSpread: Math.max(spread(pitches), 8),
      centroidSpread: Math.max(spread(centroids), 120),
      samples: pitches.length,
      createdAt: Date.now(),
    };
  }

  reset(): void {
    this.frames = [];
    this.last = null;
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.source?.disconnect();
    this.analyser?.disconnect();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.analyser = null;
    this.source = null;
  }
}

export interface VoiceMatch {
  match: boolean;
  score: number;
}

/**
 * Compares a live sample with the enrolled profile. Distance is normalised by
 * the enrolled spreads, so it tolerates a cold, a louder room or a different
 * distance from the microphone.
 */
export function compareVoice(profile: VoiceProfile, sample: VoiceSample): VoiceMatch {
  if (!sample.pitch || !sample.centroid) return { match: true, score: 0 };
  const pitchDelta = Math.abs(sample.pitch - profile.pitch) / Math.max(profile.pitchSpread * 2.2, 22);
  const centroidDelta =
    Math.abs(sample.centroid - profile.centroid) / Math.max(profile.centroidSpread * 2.2, 320);
  const distance = Math.sqrt(pitchDelta ** 2 + centroidDelta ** 2);
  return { match: distance <= 1.6, score: distance };
}

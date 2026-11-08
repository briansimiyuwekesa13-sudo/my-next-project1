/**
 * Minimal, self-contained typings for the Web Speech API recognition side.
 * lib.dom does not ship these everywhere, so we describe only what we use and
 * never touch the global namespace.
 */

export interface RecognitionAlternative {
  transcript: string;
  confidence: number;
}

export interface RecognitionResult {
  readonly length: number;
  isFinal: boolean;
  item(index: number): RecognitionAlternative;
  [index: number]: RecognitionAlternative;
}

export interface RecognitionResultList {
  readonly length: number;
  item(index: number): RecognitionResult;
  [index: number]: RecognitionResult;
}

export interface RecognitionEvent {
  resultIndex: number;
  results: RecognitionResultList;
}

export interface RecognitionErrorEvent {
  error: string;
  message?: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onspeechend: (() => void) | null;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

export function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechSupport(): {
  recognition: boolean;
  synthesis: boolean;
} {
  if (typeof window === "undefined") return { recognition: false, synthesis: false };
  return {
    recognition: Boolean(getRecognitionCtor()),
    synthesis: "speechSynthesis" in window,
  };
}

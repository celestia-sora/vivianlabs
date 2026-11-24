export const AUDIO_STREAM_CONFIG = {
  modelId: "eleven_v4",
  textBuffering: true,
  sentenceSegmentation: true,
  playbackQueue: true,
  immediatePlayback: true,
  reconnect: true,
} as const;

export const STREAM_OUTPUT_FORMAT = "pcm_24000" as const;
export const STREAM_SAMPLE_RATE = 24_000;

export type AudioStreamEvent =
  | {
      event: "audio_chunk";
      turnId: string;
      seq: number;
      audio: string;
      format: typeof STREAM_OUTPUT_FORMAT;
      sampleRate: number;
    }
  | {
      event: "audio_alignment";
      turnId: string;
      sentence: number;
      chars: string[];
      starts: number[];
      ends: number[];
    }
  | {
      event: "audio_alignment_end";
      turnId: string;
      sentence: number;
    }
  | {
      event: "audio_turn_end";
      turnId: string;
      chunkCount: number;
      ttfbMs: number | null;
      totalDurationMs: number;
    }
  | {
      event: "audio_reset";
      turnId: string;
    }
  | {
      event: "audio_error";
      turnId: string;
      code: string;
      error: string;
      audioStarted: boolean;
    };

export interface AudioStreamMetrics {
  turnId: string;
  ttfbMs: number | null;
  ttfaMs: number | null;
  totalDurationMs: number | null;
  chunkCount: number;
  playbackGaps: number;
  totalGapMs: number;
  interruptLatencyMs: number | null;
}

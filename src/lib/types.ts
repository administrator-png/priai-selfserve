import type { OutputFormat, RuntimePreset, VoiceOption } from "./options";

export type JobStatus =
  | "queued"
  | "scraping"
  | "prepping"
  | "rendering"
  | "encoding"
  | "completed"
  | "failed";

export type JobPayload = {
  prompt: string;
  websiteUrl?: string;
  outputFormat: OutputFormat;
  runtime: RuntimePreset;
  voiceId: VoiceOption["id"];
  ctaCopy?: string;
};

export type ChangeRequest = {
  id: string;
  note: string;
  createdAt: number;
};

export type JobRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: JobStatus;
  progress: number; // 0-1
  logs: string[];
  payload: JobPayload;
  result?: {
    videoPath: string;
    composition: string;
    runtimeSeconds: number;
    outputFormat: OutputFormat;
    framesRendered: number;
  };
  error?: string;
  changeRequests: ChangeRequest[];
};

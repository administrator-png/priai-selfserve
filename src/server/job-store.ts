import { randomUUID } from "crypto";
import type { JobPayload, JobRecord, JobStatus } from "@/lib/types";

const globalStore = globalThis as unknown as { __priaiJobStore?: Map<string, JobRecord> };

if (!globalStore.__priaiJobStore) {
  globalStore.__priaiJobStore = new Map();
}

const store = globalStore.__priaiJobStore;

export const listJobs = () => Array.from(store.values()).sort((a, b) => b.createdAt - a.createdAt);

export const getJob = (id: string) => store.get(id);

export const upsertJob = (job: JobRecord) => {
  store.set(job.id, job);
  return job;
};

export const updateJob = (id: string, patch: Partial<JobRecord>) => {
  const current = store.get(id);
  if (!current) throw new Error(`Job ${id} not found`);
  const next: JobRecord = {
    ...current,
    ...patch,
    logs: patch.logs ?? current.logs,
    changeRequests: patch.changeRequests ?? current.changeRequests,
    artifacts: patch.artifacts ? { ...current.artifacts, ...patch.artifacts } : current.artifacts,
    updatedAt: Date.now(),
  };
  store.set(id, next);
  return next;
};

export const createJob = (payload: JobPayload) => {
  const id = randomUUID();
  const base: JobRecord = {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "queued",
    progress: 0.02,
    logs: ["Job queued"],
    payload,
    artifacts: { voiceId: payload.voiceId },
    changeRequests: [],
  };
  store.set(id, base);
  return base;
};

export const pushLog = (id: string, line: string) => {
  const job = getJob(id);
  if (!job) return;
  const nextLogs = [...job.logs, `[${new Date().toLocaleTimeString()}] ${line}`].slice(-400);
  updateJob(id, { logs: nextLogs });
};

export const setStatus = (id: string, status: JobStatus, progress?: number) => {
  const patch: Partial<JobRecord> = { status };
  if (typeof progress === "number") patch.progress = progress;
  updateJob(id, patch);
};

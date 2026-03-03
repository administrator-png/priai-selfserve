"use server";

import { spawn } from "child_process";
import { existsSync, createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import type { JobRecord } from "@/lib/types";
import { runtimeOptions, voiceOptions } from "@/lib/options";
import { createJob, getJob, pushLog, setStatus, updateJob } from "./job-store";

const resolveWorkspaceRoot = () => {
  const envRoot = process.env.PRIAI_WORKSPACE_ROOT ? path.resolve(process.env.PRIAI_WORKSPACE_ROOT) : null;
  const candidates = [envRoot, process.cwd(), path.resolve(process.cwd(), ".."), path.resolve(process.cwd(), "../..")].filter(
    (dir): dir is string => Boolean(dir),
  );
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "output", "priai-design-video"))) {
      return dir;
    }
  }
  return candidates[0] ?? process.cwd();
};

const WORKSPACE_ROOT = resolveWorkspaceRoot();
const OUTPUT_PARENT_DIR = path.join(WORKSPACE_ROOT, "output");
const REMOTION_DIR = path.join(OUTPUT_PARENT_DIR, "priai-design-video");
const BRAND_FILE = path.join(REMOTION_DIR, "src", "priai-brand.json");
const OUTPUT_DIR = path.join(REMOTION_DIR, "out");
const REQUESTS_DIR = path.join(WORKSPACE_ROOT, "requests");
const CACHE_DIR = path.join(WORKSPACE_ROOT, ".tmp");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_REMOTION_BUCKET = process.env.SUPABASE_REMOTION_BUCKET ?? "remotion";
const SUPABASE_REMOTION_OBJECT = process.env.SUPABASE_REMOTION_OBJECT ?? "priai-design-video.tar.gz";
const SUPABASE_REMOTION_MANIFEST = `${SUPABASE_REMOTION_OBJECT}.manifest.json`;

let remotionFetchPromise: Promise<void> | null = null;

const ensureRemotionProject = async () => {
  if (existsSync(REMOTION_DIR)) return;
  if (!remotionFetchPromise) {
    remotionFetchPromise = downloadRemotionBundle().finally(() => {
      remotionFetchPromise = null;
    });
  }
  await remotionFetchPromise;
  if (!existsSync(REMOTION_DIR)) {
    throw new Error(
      `PriAi Remotion project missing at ${REMOTION_DIR}. Set PRIAI_WORKSPACE_ROOT or configure Supabase bundle access.`,
    );
  }
};

const COMPOSITION_FOR_FORMAT: Record<string, string> = {
  "16:9": "PriAiSpot",
  "1:1": "PriAiSpotSquare",
  "9:16": "PriAiSpotVertical",
};

const COMPOSITION_DURATION: Record<string, number> = {
  PriAiSpot: 1620,
  PriAiSpotSquare: 1620,
  PriAiSpotVertical: 1620,
};

const FRAME_MAP: Record<string, number> = {
  "15s": 15 * 30,
  "30s": 30 * 30,
  "60s": 60 * 30,
  "180s": 180 * 30,
};

type FirecrawlExtract = {
  brandName?: string;
  tagline?: string;
  headline?: string;
  description?: string;
  primaryColors?: string[];
  ctaText?: string;
  logoUrl?: string;
  features?: string[];
};

type FirecrawlResponse = {
  extract?: FirecrawlExtract;
  markdown?: string;
  data?: {
    extract?: FirecrawlExtract;
    markdown?: string;
  };
};

const pickFirstHeading = (markdown?: string) => {
  if (!markdown) return undefined;
  const match = markdown.match(/^#\s*(.+)$/m);
  return match ? match[1].trim() : undefined;
};

const pickFirstParagraph = (markdown?: string) => {
  if (!markdown) return undefined;
  const cleaned = markdown.replace(/^#.*$/gm, '').trim();
  const blocks = cleaned.split(/\n\s*\n/).map((block) => block.trim());
  return blocks.find((block) => block.length > 40);
};
const VOICE_FILE_MAP: Record<string, string> = Object.fromEntries(
  voiceOptions.map((voice) => [voice.id, path.join(REMOTION_DIR, "public", "audio", "voices", `${voice.id}.mp3`)]),
);

async function ensureDirs() {
  await ensureRemotionProject();
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(REQUESTS_DIR, { recursive: true });
}

async function downloadRemotionBundle() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase credentials missing; set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_PARENT_DIR, { recursive: true });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const manifestRes = await supabase.storage.from(SUPABASE_REMOTION_BUCKET).download(SUPABASE_REMOTION_MANIFEST);
  if (manifestRes.error) {
    throw new Error(`Failed to download manifest: ${manifestRes.error.message}`);
  }
  const manifestBuffer = await manifestRes.data.arrayBuffer();
  const manifest = JSON.parse(Buffer.from(manifestBuffer).toString("utf-8")) as {
    version: number;
    archiveSize: number;
    parts: { key: string; size: number }[];
  };

  const tmpArchive = path.join(CACHE_DIR, "priai-design-video.tar.gz");
  const writeStream = createWriteStream(tmpArchive);

  for (const part of manifest.parts) {
    const partRes = await supabase.storage.from(SUPABASE_REMOTION_BUCKET).download(part.key);
    if (partRes.error) {
      throw new Error(`Failed to download ${part.key}: ${partRes.error.message}`);
    }
    const buffer = Buffer.from(await partRes.data.arrayBuffer());
    writeStream.write(buffer);
  }
  await new Promise((resolve) => writeStream.end(resolve));

  await fs.rm(REMOTION_DIR, { recursive: true, force: true });
  await runCommand("tar", ["-xzf", tmpArchive, "-C", OUTPUT_PARENT_DIR], { cwd: WORKSPACE_ROOT });
  await fs.rm(tmpArchive, { force: true });
}

const runCommand = (command: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }, onChunk?: (chunk: string) => void) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    child.stdout.on("data", (data) => onChunk?.(data.toString()));
    child.stderr.on("data", (data) => onChunk?.(data.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });

const tryParseJson = (raw: string): FirecrawlResponse | null => {
  try {
    return JSON.parse(raw) as FirecrawlResponse;
  } catch {
    return null;
  }
};

export async function queueJob(payload: JobRecord["payload"]) {
  await ensureDirs();
  const job = createJob(payload);
  void runPipeline(job.id);
  return job;
}

async function runPipeline(jobId: string) {
  const job = getJob(jobId);
  if (!job) return;
  pushLog(jobId, "Pipeline started");
  setStatus(jobId, "scraping", 0.08);

  let scrapeJson: FirecrawlResponse | null = null;
  if (job.payload.websiteUrl) {
    try {
      pushLog(jobId, `Scraping brand data from ${job.payload.websiteUrl}`);
      let buffer = "";
      await runCommand("bash", ["scripts/firecrawl.sh", job.payload.websiteUrl], { cwd: WORKSPACE_ROOT }, (chunk) => {
        buffer += chunk;
        pushLog(jobId, chunk.trim());
      });
      scrapeJson = tryParseJson(buffer) ?? tryParseJson(buffer.split("\n").slice(-1)[0]);
      setStatus(jobId, "scraping", 0.18);
    } catch (err) {
      pushLog(jobId, `Firecrawl failed: ${(err as Error).message}`);
    }
  }

  setStatus(jobId, "prepping", 0.28);

  try {
    const brandRaw = await fs.readFile(BRAND_FILE, "utf-8");
    const brand = JSON.parse(brandRaw);
    const extract = scrapeJson?.extract ?? scrapeJson?.data?.extract;
    const markdown = scrapeJson?.markdown ?? scrapeJson?.data?.markdown;

    if (extract || markdown) {
      const derivedName = extract?.brandName ?? pickFirstHeading(markdown);
      const derivedTagline = extract?.tagline ?? pickFirstParagraph(markdown);
      const derivedDescription = extract?.description ?? pickFirstParagraph(markdown);

      brand.brandName = derivedName ?? brand.brandName;
      brand.product = derivedName ?? brand.product;
      brand.tagline = derivedTagline ?? brand.tagline;
      brand.headline = extract?.headline ?? derivedTagline ?? brand.headline;
      brand.description = derivedDescription ?? brand.description;
      if (Array.isArray(extract?.primaryColors) && extract?.primaryColors.length) {
        brand.primaryColors = extract.primaryColors;
      }
      brand.ctaText = job.payload.ctaCopy || extract?.ctaText || brand.ctaText;
      brand.logoUrl = extract?.logoUrl ?? brand.logoUrl;
      if (Array.isArray(extract?.features) && extract.features.length) {
        brand.designPillars = extract.features.slice(0, 4).map((feature) => ({
          title: feature,
          body: derivedDescription ?? brand.description,
        }));
      }
    } else if (job.payload.ctaCopy) {
      brand.ctaText = job.payload.ctaCopy;
    }
    await fs.writeFile(BRAND_FILE, JSON.stringify(brand, null, 2));
    pushLog(jobId, "Updated PriAi brand payload");
  } catch (err) {
    pushLog(jobId, `Failed to update brand file: ${(err as Error).message}`);
  }

  const voiceFile = VOICE_FILE_MAP[job.payload.voiceId];
  if (voiceFile) {
    try {
      const target = path.join(REMOTION_DIR, "public", "audio", "priai-narration.mp3");
      await fs.copyFile(voiceFile, target);
      pushLog(jobId, `Applied narration voice: ${job.payload.voiceId}`);
    } catch (err) {
      pushLog(jobId, `Failed to switch voice: ${(err as Error).message}`);
    }
  }

  const requestFile = path.join(REQUESTS_DIR, `${jobId}.json`);
  await fs.writeFile(
    requestFile,
    JSON.stringify(
      {
        id: jobId,
        createdAt: new Date().toISOString(),
        payload: job.payload,
        websiteSummary: scrapeJson?.extract ?? scrapeJson?.data?.extract ?? null,
      },
      null,
      2,
    ),
  );

  const composition = COMPOSITION_FOR_FORMAT[job.payload.outputFormat];
  const frames = FRAME_MAP[job.payload.runtime];
  if (!composition) {
    setStatus(jobId, "failed", 1);
    updateJob(jobId, { error: "Unsupported composition" });
    return;
  }

  const compositionDuration = COMPOSITION_DURATION[composition];
  const framesToRender = frames
    ? Math.min(frames, compositionDuration ?? frames)
    : compositionDuration ?? null;
  const frameArg = typeof framesToRender === "number" ? `--frames=0-${Math.max(framesToRender - 1, 0)}` : null;

  pushLog(jobId, `Rendering ${composition} (${job.payload.outputFormat})`);
  setStatus(jobId, "rendering", 0.4);

  const outputFile = path.join(OUTPUT_DIR, `${jobId}.mp4`);
  const args = ["remotion", "render", composition, outputFile];
  if (frameArg) {
    args.push(frameArg);
  }
  args.push("--overwrite");

  try {
    await runCommand("npx", args, { cwd: REMOTION_DIR }, (chunk) => {
      const text = chunk.trim();
      if (!text) return;
      pushLog(jobId, text);
      const renderMatch = text.match(/Rendered (\d+)\/(\d+)/);
      if (renderMatch) {
        const current = Number(renderMatch[1]);
        const total = Number(renderMatch[2]) || frames || 1000;
        const ratio = current / total;
        const mapped = 0.4 + ratio * 0.45;
        setStatus(jobId, "rendering", Math.min(mapped, 0.88));
      }
      if (text.startsWith("Encoded")) {
        setStatus(jobId, "encoding", 0.9);
      }
    });
    setStatus(jobId, "completed", 1);
    updateJob(jobId, {
      result: {
        videoPath: outputFile,
        composition,
        runtimeSeconds: runtimeOptions.find((r) => r.id === job.payload.runtime)?.seconds ?? 60,
        outputFormat: job.payload.outputFormat,
        framesRendered: framesToRender ?? compositionDuration ?? 0,
      },
    });
    pushLog(jobId, `Render complete: ${outputFile}`);
  } catch (err) {
    setStatus(jobId, "failed", 1);
    updateJob(jobId, { error: (err as Error).message });
    pushLog(jobId, `Render failed: ${(err as Error).message}`);
  }
}

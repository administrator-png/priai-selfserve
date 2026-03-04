"use server";

import { spawn } from "child_process";
import { existsSync, createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import * as tar from "tar";
import { createClient } from "@supabase/supabase-js";
import type { JobRecord } from "@/lib/types";
import { runtimeOptions, voiceOptions } from "@/lib/options";
import { createJob, getJob, pushLog, setStatus, updateJob } from "./job-store";

const WORKSPACE_ROOT = resolveWorkspaceRoot();
const OUTPUT_PARENT_DIR = path.join(WORKSPACE_ROOT, "output");
const REMOTION_DIR = path.join(OUTPUT_PARENT_DIR, "priai-design-video");
const BRAND_FILE = path.join(REMOTION_DIR, "src", "priai-brand.json");
const OUTPUT_DIR = path.join(REMOTION_DIR, "out");
const REQUESTS_DIR = path.join(WORKSPACE_ROOT, "requests");
const CACHE_DIR = path.join(WORKSPACE_ROOT, ".cache");
const LOGO_ASSET_DIR = path.join(REMOTION_DIR, "public", "images", "brands");
const NARRATION_OUTPUT = path.join(REMOTION_DIR, "public", "audio", "priai-narration.mp3");
const BUNDLE_META_PATH = path.join(OUTPUT_PARENT_DIR, ".priai-remotion-manifest.json");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_REMOTION_BUCKET = process.env.SUPABASE_REMOTION_BUCKET ?? "remotion";
const SUPABASE_REMOTION_OBJECT = process.env.SUPABASE_REMOTION_OBJECT ?? "priai-design-video.tar.gz";
const SUPABASE_REMOTION_MANIFEST = `${SUPABASE_REMOTION_OBJECT}.manifest.json`;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

const VOICE_FILE_MAP: Record<string, string> = Object.fromEntries(
  voiceOptions.map((voice) => [voice.id, path.join(REMOTION_DIR, "public", "audio", "voices", `${voice.id}.mp3`)]),
);
const DEFAULT_VOICE_ID = voiceOptions[0]?.id ?? "aurora";

const ELEVEN_LABS_VOICE_MAP: Record<string, { voiceId: string; model?: string; stability?: number; similarity?: number; style?: number }> = {
  aurora: { voiceId: "21m00Tcm4TlvDq8ikWAM", model: "eleven_multilingual_v2", stability: 0.45, similarity: 0.8, style: 0.35 },
  isla: { voiceId: "EXAVITQu4vr4xnSDxMaL", model: "eleven_multilingual_v2", stability: 0.4, similarity: 0.72, style: 0.35 },
  carys: { voiceId: "pNInz6obpgDQGcFmaJgB", model: "eleven_multilingual_v2", stability: 0.38, similarity: 0.75, style: 0.4 },
  henry: { voiceId: "TxGEqnHWrfWFTfGW9XjX", model: "eleven_multilingual_v2", stability: 0.5, similarity: 0.7, style: 0.25 },
  owen: { voiceId: "VR6AewLTigWG4xSOukaG", model: "eleven_multilingual_v2", stability: 0.42, similarity: 0.74, style: 0.3 },
  rhett: { voiceId: "AZnzlk1XvdvUeBnXmlld", model: "eleven_multilingual_v2", stability: 0.48, similarity: 0.78, style: 0.3 },
};

let remotionFetchPromise: Promise<void> | null = null;

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
  faviconUrl?: string;
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

type RemotionManifest = {
  version: number;
  archiveSize: number;
  parts: { key: string; size: number }[];
};

type BrandFile = {
  brandName: string;
  product: string;
  tagline: string;
  headline: string;
  description: string;
  logoUrl?: string;
  faviconUrl?: string;
  websiteUrl?: string;
  primaryColors: string[];
  ctaText: string;
  assets?: { logo?: string; [key: string]: string | undefined };
  designPillars: { title: string; body: string }[];
  valueStats: { label: string; value: string; caption: string; percent: number }[];
  timeline: string[];
};

const VOICE_NAME_MAP = Object.fromEntries(voiceOptions.map((voice) => [voice.id, voice.label]));

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
        const condensed = chunk.trim();
        if (condensed) pushLog(jobId, condensed);
      });
      scrapeJson = tryParseJson(buffer) ?? tryParseJson(buffer.split("\n").slice(-1)[0]);
      setStatus(jobId, "scraping", 0.18);
    } catch (err) {
      pushLog(jobId, `Firecrawl failed: ${(err as Error).message}`);
    }
  }

  setStatus(jobId, "prepping", 0.28);

  const summary = scrapeJson?.extract ?? scrapeJson?.data?.extract ?? null;
  let brandSnapshot: BrandFile | null = null;
  let narrationScript: string | null = null;

  try {
    brandSnapshot = await refreshBrandPayload(jobId, job.payload, summary, scrapeJson?.markdown);
    pushLog(jobId, "Updated PriAi brand payload");
    updateJob(jobId, {
      artifacts: {
        ...(job.artifacts ?? {}),
        brand: {
          brandName: brandSnapshot.brandName,
          tagline: brandSnapshot.tagline,
          primaryColors: brandSnapshot.primaryColors,
          logoAsset: brandSnapshot.assets?.logo,
        },
      },
    });
  } catch (err) {
    pushLog(jobId, `Failed to update brand file: ${(err as Error).message}`);
  }

  if (brandSnapshot) {
    try {
      narrationScript = buildNarrationScript({ brand: brandSnapshot, summary, payload: job.payload });
      pushLog(jobId, "Generated narration script");
      updateJob(jobId, {
        artifacts: {
          ...(getJob(jobId)?.artifacts ?? {}),
          script: narrationScript,
          voiceId: job.payload.voiceId,
        },
      });
    } catch (err) {
      pushLog(jobId, `Narration script failed: ${(err as Error).message}`);
    }
  }

  try {
    const voiceApplied = await ensureNarrationAudio(job.payload.voiceId, narrationScript);
    if (voiceApplied) {
      pushLog(jobId, `Applied narration voice via ElevenLabs: ${VOICE_NAME_MAP[job.payload.voiceId] ?? job.payload.voiceId}`);
    } else {
      pushLog(jobId, `Fallback voice applied: ${VOICE_NAME_MAP[job.payload.voiceId] ?? job.payload.voiceId}`);
    }
  } catch (err) {
    pushLog(jobId, `Failed to apply voice: ${(err as Error).message}`);
  }

  const requestFile = path.join(REQUESTS_DIR, `${jobId}.json`);
  await fs.writeFile(
    requestFile,
    JSON.stringify(
      {
        id: jobId,
        createdAt: new Date().toISOString(),
        payload: job.payload,
        websiteSummary: summary,
        narrationScript,
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
  const framesToRender = frames ? Math.min(frames, compositionDuration ?? frames) : compositionDuration ?? null;
  const frameArg = typeof framesToRender === "number" ? `--frames=0-${Math.max(framesToRender - 1, 0)}` : null;

  pushLog(jobId, `Rendering ${composition} (${job.payload.outputFormat})`);
  setStatus(jobId, "rendering", 0.4);

  const outputFile = path.join(OUTPUT_DIR, `${jobId}.mp4`);
  const args = ["remotion", "render", composition, outputFile];
  if (frameArg) args.push(frameArg);
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

async function ensureNarrationAudio(voiceId: string, script: string | null) {
  if (script && ELEVENLABS_API_KEY && ELEVEN_LABS_VOICE_MAP[voiceId]) {
    try {
      await generateElevenLabsNarration(script, voiceId);
      return true;
    } catch (err) {
      console.error('ElevenLabs narration failed', err);
    }
  }
  await copyStockVoice(voiceId);
  return false;
}

async function refreshBrandPayload(
  jobId: string,
  payload: JobRecord["payload"],
  summary: FirecrawlExtract | null,
  markdown?: string,
) {
  const brandRaw = await fs.readFile(BRAND_FILE, "utf-8");
  const brand = JSON.parse(brandRaw) as BrandFile;

  const derivedName = summary?.brandName ?? pickFirstHeading(markdown) ?? brand.brandName;
  const derivedTagline = summary?.tagline ?? pickFirstParagraph(markdown) ?? brand.tagline;
  const derivedDescription = summary?.description ?? pickFirstParagraph(markdown) ?? brand.description;

  brand.brandName = derivedName;
  brand.product = derivedName;
  brand.tagline = derivedTagline;
  brand.headline = summary?.headline ?? derivedTagline ?? brand.headline;
  brand.description = derivedDescription;
  brand.ctaText = payload.ctaCopy || summary?.ctaText || brand.ctaText;
  brand.websiteUrl = payload.websiteUrl || brand.websiteUrl;

  if (Array.isArray(summary?.primaryColors) && summary.primaryColors.length) {
    brand.primaryColors = summary.primaryColors.slice(0, 3);
  }

  if (Array.isArray(summary?.features) && summary.features.length) {
    brand.designPillars = summary.features.slice(0, 4).map((feature) => ({
      title: feature,
      body: derivedDescription,
    }));
  }

  const displayName = brand.brandName || brand.product || 'This team';
  brand.timeline = [
    `${displayName} intake brief`,
    `Scrape ${displayName} style system`,
    "Auto storyboard & narration",
    "Render + review loop",
    "Launch & iterate",
  ];

  if (summary?.logoUrl) {
    const asset = await downloadLogoAsset(summary.logoUrl, jobId);
    if (asset) {
      brand.assets = { ...(brand.assets ?? {}), logo: asset };
      brand.logoUrl = summary.logoUrl;
    }
  }

  await fs.writeFile(BRAND_FILE, JSON.stringify(brand, null, 2));
  return brand;
}

async function downloadLogoAsset(url: string, jobId: string) {
  try {
    await fs.mkdir(LOGO_ASSET_DIR, { recursive: true });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const extFromHeader = response.headers.get("content-type")?.includes("png")
      ? ".png"
      : response.headers.get("content-type")?.includes("svg")
        ? ".svg"
        : response.headers.get("content-type")?.includes("jpeg")
          ? ".jpg"
          : null;
    const urlExt = safeExtensionFromUrl(url);
    const extension = extFromHeader || urlExt || ".png";
    const relativePath = path.join("images", "brands", `${jobId}${extension}`);
    const target = path.join(REMOTION_DIR, "public", relativePath);
    await fs.writeFile(target, Buffer.from(arrayBuffer));
    return relativePath;
  } catch (err) {
    pushLog(jobId, `Logo download failed: ${(err as Error).message}`);
    return null;
  }
}

async function ensureDirs() {
  await ensureRemotionProject();
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(REQUESTS_DIR, { recursive: true });
}

async function ensureRemotionProject() {
  const remoteManifest = await fetchRemotionManifest();
  const localManifest = await readLocalManifest();
  const needsRefresh =
    !existsSync(REMOTION_DIR) ||
    !localManifest ||
    !manifestsMatch(localManifest, remoteManifest);

  if (!needsRefresh) return;

  if (!remotionFetchPromise) {
    remotionFetchPromise = (async () => {
      await downloadRemotionBundle(remoteManifest);
      await fs.writeFile(BUNDLE_META_PATH, JSON.stringify(remoteManifest, null, 2));
    })().finally(() => {
      remotionFetchPromise = null;
    });
  }

  await remotionFetchPromise;
  if (!existsSync(REMOTION_DIR)) {
    throw new Error(
      `PriAi Remotion project missing at ${REMOTION_DIR}. Set PRIAI_WORKSPACE_ROOT or configure Supabase bundle access.`,
    );
  }
}

async function fetchRemotionManifest(): Promise<RemotionManifest> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase credentials missing; set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const manifestRes = await supabase.storage.from(SUPABASE_REMOTION_BUCKET).download(SUPABASE_REMOTION_MANIFEST);
  if (manifestRes.error) {
    throw new Error(`Failed to download manifest: ${manifestRes.error.message}`);
  }
  const manifestBuffer = await manifestRes.data.arrayBuffer();
  return JSON.parse(Buffer.from(manifestBuffer).toString("utf-8")) as RemotionManifest;
}

async function readLocalManifest(): Promise<RemotionManifest | null> {
  try {
    const raw = await fs.readFile(BUNDLE_META_PATH, "utf-8");
    return JSON.parse(raw) as RemotionManifest;
  } catch {
    return null;
  }
}

const manifestsMatch = (a: RemotionManifest, b: RemotionManifest) => JSON.stringify(a) === JSON.stringify(b);

async function downloadRemotionBundle(manifest: RemotionManifest) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase credentials missing; set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_PARENT_DIR, { recursive: true });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
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
  await tar.x({ file: tmpArchive, cwd: OUTPUT_PARENT_DIR });
  await fs.rm(tmpArchive, { force: true });
}

function resolveWorkspaceRoot() {
  const defaultRoot = "/tmp/priai-workspace";
  const envRoot = process.env.PRIAI_WORKSPACE_ROOT ? path.resolve(process.env.PRIAI_WORKSPACE_ROOT) : defaultRoot;
  const candidates = [envRoot, process.cwd(), path.resolve(process.cwd(), ".."), path.resolve(process.cwd(), "../..")];
  for (const dir of candidates) {
    if (dir && existsSync(path.join(dir, "output", "priai-design-video"))) {
      return dir;
    }
  }
  return envRoot ?? process.cwd();
}

const runCommand = (
  command: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
  onChunk?: (chunk: string) => void,
) =>
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

const pickFirstHeading = (markdown?: string) => {
  if (!markdown) return undefined;
  const match = markdown.match(/^#\s*(.+)$/m);
  return match ? match[1].trim() : undefined;
};

const pickFirstParagraph = (markdown?: string) => {
  if (!markdown) return undefined;
  const cleaned = markdown.replace(/^#.*$/gm, "").trim();
  const blocks = cleaned.split(/\n\s*\n/).map((block) => block.trim());
  return blocks.find((block) => block.length > 40);
};

const WORDS_PER_SECOND = 2.6;

function buildNarrationScript({
  brand,
  summary,
  payload,
}: {
  brand: BrandFile;
  summary: FirecrawlExtract | null;
  payload: JobRecord["payload"];
}) {
  const runtimeSeconds = runtimeOptions.find((r) => r.id === payload.runtime)?.seconds ?? 60;
  const targetWords = Math.max(40, Math.min(180, Math.round(runtimeSeconds * WORDS_PER_SECOND)));

  const brandName = brand.brandName || brand.product || "This team";
  const tagline = summary?.tagline ?? brand.tagline;
  const description = summary?.description ?? brand.description;
  const directive = payload.prompt?.trim();
  const features = summary?.features?.length
    ? summary.features
    : brand.designPillars?.map((pillar) => pillar.title) ?? [];

  const opening = tagline ? `${brandName}. ${tagline}` : `${brandName} — ${description}`;
  const featureLine = features.length ? `${brandName} delivers ${formatList(features.slice(0, 3))}.` : description;
  const cta = payload.ctaCopy ?? summary?.ctaText ?? brand.ctaText;
  const closing = cta?.endsWith(".") ? cta : `${cta}.`;

  const segments = [opening, directive, featureLine, closing].filter(Boolean).map(ensureSentence);
  let script = segments.join(" ");
  const words = script.split(/\s+/);
  if (words.length > targetWords) {
    script = words.slice(0, targetWords).join(" ");
    if (!/[.!?]$/.test(script)) script += ".";
  }
  return script;
}

function ensureSentence(text?: string | null) {
  if (!text) return "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function formatList(items: string[]) {
  if (items.length <= 1) return items[0] ?? "impact";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

async function generateElevenLabsNarration(script: string, voiceId: string) {
  if (!ELEVENLABS_API_KEY) throw new Error("Missing ElevenLabs API key");
  const voiceConfig = ELEVEN_LABS_VOICE_MAP[voiceId] ?? ELEVEN_LABS_VOICE_MAP[DEFAULT_VOICE_ID];
  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${voiceConfig.voiceId}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text: script,
      model_id: voiceConfig.model ?? "eleven_multilingual_v2",
      voice_settings: {
        stability: voiceConfig.stability ?? 0.45,
        similarity_boost: voiceConfig.similarity ?? 0.75,
        style: voiceConfig.style ?? 0.35,
        use_scenic_breaks: true,
      },
    }),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`ElevenLabs failed: ${response.status} ${message}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(NARRATION_OUTPUT, buffer);
}

async function copyStockVoice(voiceId: string) {
  const source = VOICE_FILE_MAP[voiceId] ?? VOICE_FILE_MAP[DEFAULT_VOICE_ID];
  if (!source) throw new Error("No fallback voice asset available");
  await fs.copyFile(source, NARRATION_OUTPUT);
}

function safeExtensionFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const ext = path.extname(pathname);
    if (ext && ext.length <= 5) return ext;
    return null;
  } catch {
    return null;
  }
}

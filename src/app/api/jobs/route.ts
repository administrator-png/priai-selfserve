import { NextRequest, NextResponse } from "next/server";
import { outputFormats, runtimeOptions, voiceOptions } from "@/lib/options";
import type { JobPayload } from "@/lib/types";
import { listJobs } from "@/server/job-store";
import { queueJob } from "@/server/job-runner";

const VOICE_IDS = new Set(voiceOptions.map((v) => v.id));
const FORMAT_IDS = new Set(outputFormats.map((f) => f.id));
const RUNTIME_IDS = new Set(runtimeOptions.map((r) => r.id));

export async function GET() {
  return NextResponse.json({ jobs: listJobs() });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<JobPayload>;
    if (!body.prompt || body.prompt.trim().length < 12) {
      return NextResponse.json({ error: "Prompt must be at least 12 characters" }, { status: 400 });
    }
    if (!body.outputFormat || !FORMAT_IDS.has(body.outputFormat)) {
      return NextResponse.json({ error: "Invalid output format" }, { status: 400 });
    }
    if (!body.runtime || !RUNTIME_IDS.has(body.runtime)) {
      return NextResponse.json({ error: "Invalid runtime option" }, { status: 400 });
    }
    if (!body.voiceId || !VOICE_IDS.has(body.voiceId)) {
      return NextResponse.json({ error: "Invalid voice selection" }, { status: 400 });
    }

    const payload: JobPayload = {
      prompt: body.prompt.trim(),
      websiteUrl: body.websiteUrl?.trim(),
      outputFormat: body.outputFormat,
      runtime: body.runtime,
      voiceId: body.voiceId,
      ctaCopy: body.ctaCopy?.trim(),
    };

    const job = await queueJob(payload);
    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    console.error("Failed to create PriAi job", error);
    const message = error instanceof Error ? error.message : "Failed to create job";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

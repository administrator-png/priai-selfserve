import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getJob, updateJob } from "@/server/job-store";

type RouteParams = { id: string };

type RouteContext = { params: Promise<RouteParams> };

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const { note } = (await request.json()) as { note?: string };
  if (!note || note.trim().length < 6) {
    return NextResponse.json({ error: "Feedback note must be at least 6 characters" }, { status: 400 });
  }
  const changeRequests = [
    ...job.changeRequests,
    { id: randomUUID(), note: note.trim(), createdAt: Date.now() },
  ];
  updateJob(job.id, { changeRequests });
  return NextResponse.json({ ok: true });
}

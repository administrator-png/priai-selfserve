import { NextResponse } from "next/server";
import { getJob } from "@/server/job-store";

type RouteParams = { id: string };

type RouteContext = { params: Promise<RouteParams> };

export async function GET(_: Request, context: RouteContext) {
  const { id } = await context.params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ job });
}

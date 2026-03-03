import { NextResponse } from "next/server";
import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { getJob } from "@/server/job-store";

const WORKSPACE_ROOT = path.resolve(process.cwd(), "..");
const REMOTION_DIR = path.join(WORKSPACE_ROOT, "output", "priai-design-video");
const OUTPUT_DIR = path.join(REMOTION_DIR, "out");

export const runtime = "nodejs";

type RouteParams = { id: string };
type RouteContext = { params: Promise<RouteParams> };

export async function GET(_: Request, context: RouteContext) {
  const { id } = await context.params;
  const job = getJob(id);
  const fallbackPath = path.join(OUTPUT_DIR, `${id}.mp4`);
  const assetPath = job?.result?.videoPath ?? fallbackPath;

  try {
    await fs.access(assetPath);
  } catch (err) {
    console.error("Asset access failed", assetPath, err);
    return NextResponse.json({ error: "Asset not ready" }, { status: 404 });
  }

  try {
    const stat = await fs.stat(assetPath);
    const stream = createReadStream(assetPath) as unknown as BodyInit;
    return new NextResponse(stream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": stat.size.toString(),
        "Content-Disposition": `inline; filename="${path.basename(assetPath)}"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

#!/usr/bin/env node
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { promises as fsp } from "fs";
import dotenv from "dotenv";
import * as tar from "tar";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_DIR = path.resolve(__dirname, "..", "..");
const OUTPUT_DIR = path.join(WORKSPACE_DIR, "output");
const PROJECT_DIR = path.join(OUTPUT_DIR, "priai-design-video");
const TMP_DIR = path.join(WORKSPACE_DIR, ".tmp");
const ARCHIVE_PATH = path.join(TMP_DIR, "priai-design-video.tar.gz");
const PART_PREFIX = path.join(TMP_DIR, "priai-design-video.part-");
const PART_SIZE_MB = Number(process.env.SUPABASE_REMOTION_PART_SIZE_MB ?? "40");
const PART_SIZE_BYTES = PART_SIZE_MB * 1024 * 1024;

dotenv.config({ path: path.join(WORKSPACE_DIR, ".env") });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_REMOTION_BUCKET || "remotion";
const OBJECT_KEY = process.env.SUPABASE_REMOTION_OBJECT || "priai-design-video.tar.gz";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
  process.exit(1);
}

if (!fs.existsSync(PROJECT_DIR)) {
  console.error(`Remotion project not found at ${PROJECT_DIR}`);
  process.exit(1);
}

if (!Number.isFinite(PART_SIZE_BYTES) || PART_SIZE_BYTES <= 0) {
  console.error("Invalid SUPABASE_REMOTION_PART_SIZE_MB value");
  process.exit(1);
}

await fsp.rm(TMP_DIR, { recursive: true, force: true });
await fsp.mkdir(TMP_DIR, { recursive: true });

console.log(`> Creating archive ${ARCHIVE_PATH}`);
try {
  await tar.c(
    {
      gzip: true,
      cwd: OUTPUT_DIR,
      file: ARCHIVE_PATH,
    },
    ["priai-design-video"],
  );
} catch (error) {
  console.error("Failed to create archive", error?.message ?? error);
  process.exit(1);
}

const archiveStats = await fsp.stat(ARCHIVE_PATH);
console.log(`> Archive size ${(archiveStats.size / (1024 * 1024)).toFixed(2)} MB`);

console.log(`> Splitting archive into ~${PART_SIZE_MB}MB parts`);
try {
  await splitArchiveIntoParts(ARCHIVE_PATH, PART_PREFIX, PART_SIZE_BYTES);
} catch (error) {
  console.error("Failed to split archive", error?.message ?? error);
  process.exit(1);
}

const partFiles = (await fsp.readdir(TMP_DIR))
  .filter((file) => file.startsWith(path.basename(PART_PREFIX)))
  .sort();

if (partFiles.length === 0) {
  console.error("No part files created");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

console.log(`> Ensuring bucket '${BUCKET}' exists`);
const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();
if (bucketError) {
  console.error("Failed to list buckets", bucketError.message);
  process.exit(1);
}
if (!buckets?.some((bucket) => bucket.name === BUCKET)) {
  const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
  if (error) {
    console.error("Failed to create bucket", error.message);
    process.exit(1);
  }
  console.log(`Created bucket '${BUCKET}'`);
}

const manifest = {
  version: 1,
  createdAt: new Date().toISOString(),
  archiveSize: archiveStats.size,
  partSizeBytes: PART_SIZE_BYTES,
  parts: [],
};

for (const [index, file] of partFiles.entries()) {
  const localPath = path.join(TMP_DIR, file);
  const remoteKey = `${OBJECT_KEY}.part-${String(index).padStart(3, "0")}`;
  const buffer = await fsp.readFile(localPath);
  console.log(`> Uploading part ${index + 1}/${partFiles.length}: ${remoteKey} (${(buffer.length / (1024 * 1024)).toFixed(2)} MB)`);
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(remoteKey, buffer, {
    upsert: true,
    contentType: "application/octet-stream",
  });
  if (uploadError) {
    console.error("Upload failed", uploadError.message);
    process.exit(1);
  }
  manifest.parts.push({ key: remoteKey, size: buffer.length });
  await fsp.rm(localPath);
}

await fsp.rm(ARCHIVE_PATH, { force: true });

const manifestKey = `${OBJECT_KEY}.manifest.json`;
console.log(`> Uploading manifest ${manifestKey}`);
const { error: manifestError } = await supabase.storage.from(BUCKET).upload(manifestKey, Buffer.from(JSON.stringify(manifest, null, 2)), {
  upsert: true,
  contentType: "application/json",
});
if (manifestError) {
  console.error("Failed to upload manifest", manifestError.message);
  process.exit(1);
}

console.log("Upload complete.");

async function splitArchiveIntoParts(archivePath, partPrefix, partSizeBytes) {
  return new Promise((resolve, reject) => {
    let partIndex = 0;
    let currentSize = 0;
    let currentStream = null;

    const openNewPart = () => {
      const filePath = `${partPrefix}${String(partIndex).padStart(3, "0")}`;
      partIndex += 1;
      currentSize = 0;
      currentStream = fs.createWriteStream(filePath);
      currentStream.on("error", reject);
    };

    const closeCurrentPart = (cb) => {
      if (currentStream) {
        currentStream.end(cb);
        currentStream = null;
      } else if (cb) {
        cb();
      }
    };

    const archiveStream = fs.createReadStream(archivePath);
    archiveStream.on("error", reject);

    archiveStream.on("data", (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (!currentStream) {
          openNewPart();
        }

        const remainingInPart = partSizeBytes - currentSize;
        const bytesAvailable = chunk.length - offset;
        const bytesToWrite = Math.min(bytesAvailable, remainingInPart);
        currentStream.write(chunk.subarray(offset, offset + bytesToWrite));
        offset += bytesToWrite;
        currentSize += bytesToWrite;

        if (currentSize >= partSizeBytes) {
          closeCurrentPart();
          currentSize = 0;
        }
      }
    });

    archiveStream.on("end", () => {
      closeCurrentPart(resolve);
    });
  });
}

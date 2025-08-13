import fs from "fs";
import path from "path";

// Generic retry helper
export async function retry(fn, retries = 3, delay = 500) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      const backoff = delay * 2 ** attempt + Math.random() * 100;
      console.error(`Retrying (${attempt}/${retries}): ${err.message}`);
      await new Promise((res) => setTimeout(res, backoff));
    }
  }
}

// JSON safe read
export function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

// Template renderer
export function renderTemplate(content, data) {
  return content.replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => data[key] ?? `{{${key}}}`
  );
}

// Ensure directory exists
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// S3 URL helper
export function getS3Url(bucket, region, key) {
  return `https://${bucket}/${key}`;
}

export function copyIfNotExists(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const file of fs.readdirSync(srcDir)) {
    const dest = path.join(destDir, file);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(srcDir, file), dest);
      copied.push(file);
    }
  }
  return copied.length;
}

import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { retry } from "./utils.js";
import { CONFIG } from "./config.js";

const s3 = new S3Client({
  region: CONFIG.REGION,
  credentials: {
    accessKeyId: CONFIG.ACCESS_KEY,
    secretAccessKey: CONFIG.SECRET_KEY,
  },
});

async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export async function s3ObjectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: CONFIG.BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err.name === "NotFound") return false;
    throw err;
  }
}

export async function downloadS3Prefix(prefix, localDir) {
  fs.mkdirSync(localDir, { recursive: true });
  let ContinuationToken;

  do {
    const list = await retry(() =>
      s3.send(
        new ListObjectsV2Command({
          Bucket: CONFIG.BUCKET,
          Prefix: prefix,
          ContinuationToken,
        })
      )
    );

    if (!list.Contents) break;

    for (const obj of list.Contents) {
      if (!obj.Key.endsWith("/")) {
        const localPath = path.join(localDir, path.basename(obj.Key));
        try {
          const res = await retry(() =>
            s3.send(
              new GetObjectCommand({ Bucket: CONFIG.BUCKET, Key: obj.Key })
            )
          );
          const buf = await streamToBuffer(res.Body);
          fs.writeFileSync(localPath, buf);
          console.log(`Downloaded: ${obj.Key}`);
        } catch (err) {
          console.error(`Failed to download ${obj.Key}: ${err.message}`);
        }
      }
    }

    ContinuationToken = list.IsTruncated
      ? list.NextContinuationToken
      : undefined;
  } while (ContinuationToken);
}

export async function uploadFileToS3(
  key,
  filePath,
  contentType = "application/pdf"
) {
  await retry(() =>
    s3.send(
      new PutObjectCommand({
        Bucket: CONFIG.BUCKET,
        Key: key,
        Body: fs.readFileSync(filePath),
        ContentType: contentType,
      })
    )
  );
  console.log(`Uploaded: ${key}`);
}

export { s3 };

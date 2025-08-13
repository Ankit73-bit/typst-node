// simplePdfUploader.js
import fs from "fs";
import path from "path";
import * as typst from "typst";
import dotenv from "dotenv";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import XLSX from "xlsx";
import readline from "readline";
import pLimit from "p-limit";
import cliProgress from "cli-progress";

dotenv.config();

// ---- Config ----
const CONFIG = {
  BUCKET: process.env.S3_BUCKET_NAME,
  REGION: process.env.AWS_REGION,
  ACCESS_KEY: process.env.AWS_ACCESS_KEY_ID,
  SECRET_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  TEMPLATE_PREFIX: process.env.S3_TEMPLATE_PREFIX,
  IMAGE_PREFIX: process.env.S3_IMAGE_PREFIX,
  DATA_FILE: process.env.DATA_FILE,
  OUTPUT_PREFIX: process.env.S3_OUTPUT_PREFIX,
};

// ---- AWS S3 Client ----
const s3 = new S3Client({
  region: CONFIG.REGION,
  credentials: {
    accessKeyId: CONFIG.ACCESS_KEY,
    secretAccessKey: CONFIG.SECRET_KEY,
  },
});

// Create write streams for logging
const processLogStream = fs.createWriteStream("process.log", { flags: "a" });
const errorLogStream = fs.createWriteStream("error.log", { flags: "a" });

// Logging helpers
function timestamp() {
  return new Date().toISOString();
}

function logInfo(...args) {
  const msg = `[${timestamp()}] INFO: ${args.join(" ")}\n`;
  processLogStream.write(msg);
}

function logError(...args) {
  const msg = `[${timestamp()}] ERROR: ${args.join(" ")}\n`;
  errorLogStream.write(msg);
}

// Clean console output, only show progress bar
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function downloadS3Prefix(prefix, localDir) {
  fs.mkdirSync(localDir, { recursive: true });
  let ContinuationToken = undefined;

  logInfo(
    `Starting download from S3 prefix: ${prefix} to local directory: ${localDir}`
  );

  do {
    try {
      const list = await s3.send(
        new ListObjectsV2Command({
          Bucket: CONFIG.BUCKET,
          Prefix: prefix,
          ContinuationToken,
        })
      );

      if (!list.Contents) break;

      for (const obj of list.Contents) {
        if (!obj.Key.endsWith("/")) {
          const fileName = path.basename(obj.Key);
          const localPath = path.join(localDir, fileName);

          try {
            const res = await s3.send(
              new GetObjectCommand({ Bucket: CONFIG.BUCKET, Key: obj.Key })
            );
            const buf = await streamToBuffer(res.Body);
            fs.writeFileSync(localPath, buf);
            logInfo(`Downloaded: ${obj.Key}`);
          } catch (error) {
            logError(
              `Failed to download ${obj.Key}: ${error.message || error}`
            );
          }
        }
      }

      ContinuationToken = list.IsTruncated
        ? list.NextContinuationToken
        : undefined;
    } catch (error) {
      logError(`Error listing S3 objects: ${error.message || error}`);
      // continue retry? for now just stop
      break;
    }
  } while (ContinuationToken);

  logInfo(`Completed downloading prefix: ${prefix}`);
}

async function uploadFileToS3(key, filePath) {
  try {
    const fileContent = fs.readFileSync(filePath);
    await s3.send(
      new PutObjectCommand({
        Bucket: CONFIG.BUCKET,
        Key: key,
        Body: fileContent,
        ContentType: "application/pdf",
      })
    );
    logInfo(`Uploaded: ${key}`);
  } catch (err) {
    logError(`Failed to upload ${key}: ${err.message || err}`);
  }
}

async function generateAndUploadPDFs() {
  const templateDir = "./template";
  const imageDir = "./image";
  const outputDir = "./output";

  fs.mkdirSync(outputDir, { recursive: true });

  logInfo("Downloading templates...");
  await downloadS3Prefix(CONFIG.TEMPLATE_PREFIX, templateDir);

  logInfo("Downloading images...");
  await downloadS3Prefix(CONFIG.IMAGE_PREFIX, imageDir);

  // Read data
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, "utf-8"));
    logInfo(`Loaded ${rows.length} data rows from ${CONFIG.DATA_FILE}`);
  } catch (error) {
    logError(
      `Failed to read or parse data file: ${CONFIG.DATA_FILE} - ${
        error.message || error
      }`
    );
    rows = [];
  }

  // Copy images only once
  if (fs.existsSync(imageDir)) {
    const imageFiles = fs.readdirSync(imageDir);
    let imagesCopied = 0;
    for (const img of imageFiles) {
      const src = path.join(imageDir, img);
      const dest = path.join(outputDir, img);
      if (!fs.existsSync(dest)) {
        try {
          fs.copyFileSync(src, dest);
          imagesCopied++;
        } catch (error) {
          logError(`Failed to copy image ${img}: ${error.message || error}`);
        }
      }
    }
    logInfo(`Copied ${imagesCopied} new images to output folder`);
  }

  // Read templates
  let templates = [];
  try {
    templates = fs.readdirSync(templateDir).filter((f) => f.endsWith(".typ"));
    logInfo(`Found ${templates.length} template(s) in ${templateDir}`);
  } catch (error) {
    logError(`Failed to read templates directory: ${error.message || error}`);
  }

  if (!rows.length || !templates.length) {
    logError("No data rows or templates found, aborting PDF generation");
    return;
  }

  // Setup progress bar
  const totalTasks = rows.length * templates.length;
  const progressBar = new cliProgress.SingleBar(
    {
      format: "Progress |{bar}| {percentage}% | {value}/{total} PDFs",
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );
  progressBar.start(totalTasks, 0);

  const limit = pLimit(3);
  const excelData = [];

  const pdfGenerationTasks = rows.map((row, i) =>
    limit(async () => {
      const firstValue = Object.values(row)[0];
      const safeName = String(firstValue || `doc_${i}`).replace(
        /[^\w\-]/g,
        "_"
      );

      for (const tmpl of templates) {
        let content;
        try {
          content = fs.readFileSync(path.join(templateDir, tmpl), "utf-8");
        } catch (error) {
          logError(
            `Failed to read template ${tmpl}: ${error.message || error}`
          );
          progressBar.increment();
          continue;
        }

        content = content.replace(/\{\{(\w+)\}\}/g, (_, key) =>
          row[key] !== undefined ? row[key] : `{{${key}}}`
        );

        const outTyp = path.join(outputDir, `${safeName}.typ`);
        const outPdf = path.join(outputDir, `${safeName}.pdf`);

        try {
          fs.writeFileSync(outTyp, content, "utf-8");
          await typst.compile(outTyp, outPdf);
          fs.unlinkSync(outTyp);
          logInfo(`Compiled PDF for ${safeName} using template ${tmpl}`);
        } catch (error) {
          logError(
            `Failed to compile PDF for ${safeName}: ${error.message || error}`
          );
          progressBar.increment();
          continue;
        }

        try {
          const s3Key = `${CONFIG.OUTPUT_PREFIX}${safeName}.pdf`;
          await uploadFileToS3(s3Key, outPdf);

          const pdfUrl = `https://${CONFIG.BUCKET}.s3.${CONFIG.REGION}.amazonaws.com/${s3Key}`;

          excelData.push({
            ...row,
            pdfName: safeName,
            pdfUrl,
          });
        } catch (error) {
          logError(
            `Failed during upload or excel update for ${safeName}: ${
              error.message || error
            }`
          );
        }
        progressBar.increment();
      }
    })
  );

  await Promise.all(pdfGenerationTasks);
  progressBar.stop();

  // Create Excel
  try {
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "PDF Links");

    const excelPath = path.join(outputDir, "pdf_links.xlsx");
    XLSX.writeFile(workbook, excelPath);
    logInfo(`Excel file created at ${excelPath}`);

    // Upload Excel file
    const excelS3Key = `${CONFIG.OUTPUT_PREFIX}pdf_links.xlsx`;
    await uploadFileToS3(excelS3Key, excelPath);
  } catch (error) {
    logError(
      `Failed to create or upload Excel file: ${error.message || error}`
    );
  }
}

(async () => {
  try {
    const prefix = await askQuestion(
      `Enter the S3 output prefix (default: ${CONFIG.OUTPUT_PREFIX}): `
    );
    CONFIG.OUTPUT_PREFIX = prefix.trim() || CONFIG.OUTPUT_PREFIX;

    logInfo("Starting PDF generation and upload process...");

    const startTime = Date.now();

    await generateAndUploadPDFs();

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    logInfo(`Process completed in ${duration} seconds`);

    console.log(
      `\nProcess completed in ${duration} seconds. See process.log and error.log for details.`
    );
  } catch (err) {
    logError(`Fatal error: ${err.message || err}`);
    console.error("Fatal error occurred. See error.log for details.");
    process.exit(1);
  } finally {
    processLogStream.end();
    errorLogStream.end();
  }
})();

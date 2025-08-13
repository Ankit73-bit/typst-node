import fs from "fs";
import path from "path";
import XLSX from "xlsx";
import cliProgress from "cli-progress";
import pLimit from "p-limit";

import { CONFIG } from "./config.js";
import { selectTemplateAndOutput } from "./s3Selector.js";
import {
  downloadS3Prefix,
  uploadFileToS3,
  s3ObjectExists,
  s3,
} from "./s3Utils.js";
import {
  safeReadJson,
  copyIfNotExists,
  renderTemplate,
  ensureDir,
  retry,
} from "./utils.js";
import { generatePDFs } from "./pdfGenerator.js";
import { GetObjectCommand } from "@aws-sdk/client-s3";

(async () => {
  try {
    // 1️⃣ Select template and output
    await selectTemplateAndOutput();

    const templateDir = "./template";
    const imageDir = "./image";
    const outputDir = "./output";
    const localDataFile = "./data.json";

    ensureDir(templateDir);
    ensureDir(imageDir);
    ensureDir(outputDir);

    // 2️⃣ Download S3 content
    console.log("Downloading templates...");
    await downloadS3Prefix(CONFIG.TEMPLATE_PREFIX, templateDir);

    console.log("Downloading images...");
    await downloadS3Prefix(CONFIG.IMAGE_PREFIX, imageDir);

    console.log("Downloading data file...");
    const res = await s3.send(
      new GetObjectCommand({ Bucket: CONFIG.BUCKET, Key: CONFIG.DATA_FILE })
    );
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    fs.writeFileSync(localDataFile, Buffer.concat(chunks), "utf8");

    // 3️⃣ Load rows and copy images
    const rows = safeReadJson(localDataFile);
    if (!rows.length) throw new Error("Data file is empty");

    copyIfNotExists(imageDir, outputDir);

    // 4️⃣ Load templates
    const templates = fs
      .readdirSync(templateDir)
      .filter((f) => f.endsWith(".typ"))
      .map((f) => path.join(templateDir, f));

    if (!templates.length) throw new Error("No .typ templates found");

    // 5️⃣ Single progress bar for all PDFs
    const progress = new cliProgress.SingleBar(
      {},
      cliProgress.Presets.shades_classic
    );
    progress.start(rows.length * templates.length, 0);

    // 6️⃣ Concurrent PDF generation
    const limit = pLimit(CONFIG.CONCURRENCY);
    const allResults = [];

    await Promise.all(
      rows.map((row) =>
        limit(async () => {
          const results = await generatePDFs(
            [row],
            templates,
            outputDir,
            (inc) => progress.increment(inc)
          );
          allResults.push(...results);
        })
      )
    );

    progress.stop();

    // 7️⃣ Create Excel with hyperlinks
    const uniqueResults = Object.values(
      allResults.reduce((acc, cur) => {
        acc[cur.pdfName] = cur;
        return acc;
      }, {})
    );

    const excelRows = uniqueResults.map((r) => ({
      ...r,
      pdfUrl: r.pdfUrl || "",
      pdfName: r.pdfName || "",
    }));

    const headers = Object.keys(excelRows[0] || {});
    const ws = XLSX.utils.json_to_sheet(excelRows, { header: headers });

    const ref = ws["!ref"];
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      const pdfUrlCol = headers.indexOf("pdfUrl");
      const pdfNameCol = headers.indexOf("pdfName");

      for (let R = 1; R <= range.e.r; ++R) {
        const urlAddr = XLSX.utils.encode_cell({ r: R, c: pdfUrlCol });
        const nameAddr = XLSX.utils.encode_cell({ r: R, c: pdfNameCol });
        const url = ws[urlAddr]?.v;
        const name = ws[nameAddr]?.v || "Open";
        if (url)
          ws[urlAddr] = { t: "s", f: `HYPERLINK("${url}","${name}.pdf")` };
      }
    }

    const excelPath = path.join(outputDir, "pdf_links.xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "PDF Links");
    XLSX.writeFile(wb, excelPath);
    console.log(`✅ Excel file created: ${excelPath}`);

    // 8️⃣ Upload Excel to S3
    await uploadFileToS3(
      `${CONFIG.OUTPUT_PREFIX}pdf_links.xlsx`,
      excelPath,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    console.log(
      `✅ Excel uploaded to S3: ${CONFIG.OUTPUT_PREFIX}pdf_links.xlsx`
    );
  } catch (err) {
    console.error("Fatal error:", err);
  }
})();

import fs from "fs";
import path from "path";
import * as typst from "typst";
import { ensureDir, retry, renderTemplate, getS3Url } from "./utils.js";
import { uploadFileToS3, s3ObjectExists } from "./s3Utils.js";
import { CONFIG } from "./config.js";

export async function generatePDFs(rows, templatePaths, outputDir) {
  ensureDir(outputDir);

  const templates = templatePaths.reduce((cache, tmpl) => {
    cache[path.basename(tmpl)] = fs.readFileSync(tmpl, "utf8");
    return cache;
  }, {});

  const results = [];

  for (const row of rows) {
    const safeName = String(Object.values(row)[0] || Date.now()).replace(
      /[^\w\-]/g,
      "_"
    );
    const s3Key = `${CONFIG.OUTPUT_PREFIX}${safeName}.pdf`;

    if (await s3ObjectExists(s3Key)) {
      results.push({
        ...row,
        pdfName: safeName,
        pdfUrl: getS3Url(CONFIG.BUCKET, CONFIG.REGION, s3Key),
      });
      continue;
    }

    try {
      const content = renderTemplate(Object.values(templates)[0], row);
      const typFile = path.join(outputDir, `${safeName}.typ`);
      const pdfFile = path.join(outputDir, `${safeName}.pdf`);

      fs.writeFileSync(typFile, content, "utf8");
      await retry(() => typst.compile(typFile, pdfFile));
      fs.unlinkSync(typFile);

      await uploadFileToS3(s3Key, pdfFile);

      results.push({
        ...row,
        pdfName: safeName,
        pdfUrl: getS3Url(CONFIG.BUCKET, CONFIG.REGION, s3Key),
      });
    } catch (err) {
      results.push({ ...row, pdfName: safeName, error: err.message });
    }
  }

  return results;
}

import dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  BUCKET: process.env.S3_BUCKET_NAME,
  REGION: process.env.AWS_REGION,
  ACCESS_KEY: process.env.AWS_ACCESS_KEY_ID,
  SECRET_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  CONCURRENCY: Number(process.env.CONCURRENCY || 3),
  OUTPUT_PREFIX: process.env.S3_OUTPUT_PREFIX || "",

  TEMPLATE_PREFIX: "", // dynamically set
  IMAGE_PREFIX: "", // dynamically set
  DATA_FILE: "", // dynamically set
};

export function validateConfig(config) {
  for (const [key, value] of Object.entries(config)) {
    if (
      !value &&
      !["TEMPLATE_PREFIX", "IMAGE_PREFIX", "DATA_FILE"].includes(key)
    ) {
      throw new Error(`Missing required config value: ${key}`);
    }
  }
}
validateConfig(CONFIG);

import inquirer from "inquirer";
import { CONFIG } from "./config.js";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: CONFIG.REGION,
  credentials: {
    accessKeyId: CONFIG.ACCESS_KEY,
    secretAccessKey: CONFIG.SECRET_KEY,
  },
});

// List "folders" in S3
async function listS3Folders(prefix = "") {
  const list = await s3.send(
    new ListObjectsV2Command({
      Bucket: CONFIG.BUCKET,
      Prefix: prefix,
      Delimiter: "/",
    })
  );

  // Debug log to check S3 response
  console.log("S3 list for prefix:", prefix, list.CommonPrefixes);

  return (
    list.CommonPrefixes?.map((p) =>
      p.Prefix.replace(prefix, "").replace(/\/$/, "")
    ) || []
  );
}

export async function selectTemplateAndOutput() {
  // Step 1: Select Client
  const clients = await listS3Folders("TEMPLATE/");
  if (clients.length === 0) {
    throw new Error("No clients found in S3 bucket under TEMPLATE/ folder");
  }

  const { client } = await inquirer.prompt([
    {
      type: "list",
      name: "client",
      message: "Select client:",
      choices: clients,
    },
  ]);

  // Step 2: Select Template folder (notice)
  const templates = await listS3Folders(`TEMPLATE/${client}/Templates/`);
  if (templates.length === 0) {
    throw new Error(`No templates found under TEMPLATE/${client}/Templates/`);
  }

  const { template } = await inquirer.prompt([
    {
      type: "list",
      name: "template",
      message: "Select template folder (notice):",
      choices: templates,
    },
  ]);

  // Step 3: Select subfolder (optional)
  const subfolders = await listS3Folders(
    `TEMPLATE/${client}/Templates/${template}/`
  );
  let subfolder = "";
  if (subfolders.length > 0) {
    const res = await inquirer.prompt([
      {
        type: "list",
        name: "subfolder",
        message: "Select subfolder (optional):",
        choices: [...subfolders, "None"],
      },
    ]);
    if (res.subfolder !== "None") subfolder = res.subfolder;
  }

  // Step 4: Ask for OUTPUT_PREFIX
  const { outputPrefix } = await inquirer.prompt([
    {
      type: "input",
      name: "outputPrefix",
      message: "Enter S3 output prefix for PDFs:",
      default: CONFIG.OUTPUT_PREFIX,
    },
  ]);

  // Set final S3 paths
  CONFIG.TEMPLATE_PREFIX = `TEMPLATE/${client}/Templates/${template}${
    subfolder ? "/" + subfolder : ""
  }/`;
  CONFIG.IMAGE_PREFIX = `TEMPLATE/${client}/Images/`;
  CONFIG.DATA_FILE = `TEMPLATE/${client}/Data/data.json`;
  CONFIG.OUTPUT_PREFIX = outputPrefix.endsWith("/")
    ? outputPrefix
    : outputPrefix + "/";

  console.log("\n✅ Selected paths:");
  console.log("Template Prefix:", CONFIG.TEMPLATE_PREFIX);
  console.log("Image Prefix:", CONFIG.IMAGE_PREFIX);
  console.log("Data File:", CONFIG.DATA_FILE);
  console.log("Output Prefix:", CONFIG.OUTPUT_PREFIX);
}

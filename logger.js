import fs from "fs";

const processLogStream = fs.createWriteStream("process.log", { flags: "a" });
const errorLogStream = fs.createWriteStream("error.log", { flags: "a" });

function timestamp() {
  return new Date().toISOString();
}

export function logInfo(...args) {
  const msg = `[${timestamp()}] INFO: ${args.join(" ")}\n`;
  processLogStream.write(msg);
}

export function logError(...args) {
  const msg = `[${timestamp()}] ERROR: ${args.join(" ")}\n`;
  errorLogStream.write(msg);
}

export function closeLogs() {
  processLogStream.end();
  errorLogStream.end();
}

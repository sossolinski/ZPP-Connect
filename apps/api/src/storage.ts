import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { config } from "./config.js";

const uploadDir = path.resolve(config.dataDir, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

export const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]+/g, "_");
      cb(null, `${Date.now()}-${safeName}`);
    }
  }),
  limits: {
    fileSize: 20 * 1024 * 1024
  }
});

export function storageKeyForFile(file: Express.Multer.File) {
  return path.relative(config.dataDir, file.path);
}

export function resolveStorageKey(storageKey: string) {
  return path.resolve(config.dataDir, storageKey);
}

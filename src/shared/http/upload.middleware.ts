import type { NextFunction, Request, Response } from "express";
import multer from "multer";

import { HttpError } from "../http/http-error";

export type DetectedImage = { mimeType: "image/jpeg" | "image/png" | "image/webp"; extension: "jpg" | "png" | "webp" };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const MAX_UPLOAD_IMAGES = 10;

const multiUploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_UPLOAD_IMAGES, fields: 10, fieldSize: 2_000 },
});

/** Parses the multipart `files` field (up to 10 images) into req.files (memory) and the text fields into req.body. */
export const uploadImages = multiUploader.array("files", MAX_UPLOAD_IMAGES);

/** Decides the real type from the first bytes. The client Content-Type and file name are never trusted. */
export function detectImageType(buffer: Buffer): DetectedImage | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return null;
}

/** Route-level guard so the multipart body is only parsed for requests that actually are multipart. */
export function requireMultipart(req: Request, _res: Response, next: NextFunction): void {
  if (!req.is("multipart/form-data")) {
    next(new HttpError(415, "Send the scrap order as multipart/form-data with the images in a 'files' field."));
    return;
  }
  next();
}

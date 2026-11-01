import type { ErrorRequestHandler } from "express";
import { Prisma } from "@prisma/client";
import multer from "multer";

import { HttpError } from "./http-error";

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "The image is larger than the 5 MB limit." });
      return;
    }
    res.status(400).json({ error: "The upload was not valid. Send one image in the 'file' field." });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      res.status(409).json({ error: "A record with these details already exists." });
      return;
    }

    if (error.code === "P2025") {
      res.status(404).json({ error: "The requested record was not found." });
      return;
    }
  }

  console.error("Unhandled request error.", {
    method: req.method,
    path: req.path,
    error,
  });
  res.status(500).json({ error: "An unexpected server error occurred." });
};

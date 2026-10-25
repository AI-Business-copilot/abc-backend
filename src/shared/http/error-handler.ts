import type { ErrorRequestHandler } from "express";
import { Prisma } from "@prisma/client";

import { HttpError } from "./http-error";

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({ error: error.message });
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

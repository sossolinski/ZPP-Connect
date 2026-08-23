import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "./logger.js";

export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function asyncHandler<T extends Request = Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: T, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function notFound(_req: Request, _res: Response, next: NextFunction) {
  next(new HttpError(404, "Route not found"));
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: "Validation failed",
      details: error.flatten()
    });
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.status).json({
      error: error.message,
      details: error.details
    });
    return;
  }

  if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
    res.status(409).json({ error: "A record with the same durable identity already exists." });
    return;
  }
  if (error && typeof error === "object" && "code" in error && error.code === "P2004") {
    res.status(409).json({ error: "The requested durable state conflicts with an active relationship." });
    return;
  }
  if (error && typeof error === "object" && "code" in error && error.code === "P2025") {
    res.status(404).json({ error: "The requested durable record was not found." });
    return;
  }

  logger.error({ err: error, path: req.path }, "Unhandled API error");
  res.status(500).json({ error: "Internal server error" });
}

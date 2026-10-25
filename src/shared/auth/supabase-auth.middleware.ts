import type { NextFunction, Request, Response } from "express";

import { HttpError } from "../http/http-error";

export interface AuthenticatedIdentity {
  id: string;
  email: string;
  emailVerified: boolean;
  metadata: Record<string, unknown>;
}

declare global {
  namespace Express {
    interface Request {
      identity?: AuthenticatedIdentity;
    }
  }
}

interface SupabaseAuthUser {
  id?: unknown;
  email?: unknown;
  email_confirmed_at?: unknown;
  confirmed_at?: unknown;
  user_metadata?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function requireSupabaseIdentity(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authorization = req.header("authorization");
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!token) {
      throw new HttpError(401, "A Supabase access token is required.");
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      throw new HttpError(503, "Supabase Auth is not configured on the server.");
    }

    let response: globalThis.Response;
    try {
      response = await fetch(new URL("/auth/v1/user", supabaseUrl), {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new HttpError(503, "Supabase Auth could not be reached.");
    }

    if (response.status === 401 || response.status === 403) {
      throw new HttpError(401, "The Supabase access token is invalid or expired.");
    }
    if (!response.ok) {
      throw new HttpError(503, "Supabase Auth could not validate the access token.");
    }

    const body: unknown = await response.json();
    if (!isRecord(body)) {
      throw new HttpError(503, "Supabase Auth returned an invalid user response.");
    }

    const authUser = body as SupabaseAuthUser;
    if (typeof authUser.id !== "string" || typeof authUser.email !== "string") {
      throw new HttpError(401, "The authenticated Supabase account has no email address.");
    }

    const metadata = isRecord(authUser.user_metadata) ? authUser.user_metadata : {};
    req.identity = {
      id: authUser.id,
      email: authUser.email.trim().toLowerCase(),
      emailVerified: Boolean(authUser.email_confirmed_at || authUser.confirmed_at),
      metadata,
    };

    next();
  } catch (error) {
    next(error);
  }
}

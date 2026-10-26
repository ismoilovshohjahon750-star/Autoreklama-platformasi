import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";
import { ensureAppUser } from "../lib/autoreklama";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const user = await ensureAppUser(userId);
  if (user.status !== "active") {
    res.status(403).json({ error: "Hisob vaqtincha bloklangan" });
    return;
  }
  req.userId = userId;
  next();
}

export function requireRole(...allowedRoles: string[]) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (!req.userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const user = await ensureAppUser(req.userId);
    if (user.status !== "active") {
      res.status(403).json({ error: "Hisob vaqtincha bloklangan" });
      return;
    }
    if (!allowedRoles.includes(user.role)) {
      res.status(403).json({ error: "Bu amal uchun ruxsat yo‘q" });
      return;
    }
    next();
  };
}

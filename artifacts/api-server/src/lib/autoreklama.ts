import { clerkClient } from "@clerk/express";
import { desc, eq } from "drizzle-orm";
import {
  activityEventsTable,
  appUsersTable,
  auditLogsTable,
  db,
  type AppUser,
} from "@workspace/db";

export async function ensureAppUser(userId: string): Promise<AppUser> {
  const [existing] = await db
    .select()
    .from(appUsersTable)
    .where(eq(appUsersTable.id, userId))
    .limit(1);

  if (existing) {
    return promoteAllowlistedAdmin(existing);
  }

  const clerkUser = await clerkClient.users.getUser(userId);
  const email =
    clerkUser.emailAddresses.find(
      (address) => address.id === clerkUser.primaryEmailAddressId,
    )?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    `${userId}@unknown.local`;
  const name =
    [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") ||
    email.split("@")[0] ||
    "Foydalanuvchi";
  const adminEmails = new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  const [created] = await db
    .insert(appUsersTable)
    .values({
      id: userId,
      email,
      name,
      role: adminEmails.has(email.toLowerCase()) ? "admin" : "advertiser",
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return created;
  }

  const [afterConflict] = await db
    .select()
    .from(appUsersTable)
    .where(eq(appUsersTable.id, userId))
    .limit(1);
  if (!afterConflict) {
    throw new Error("Could not initialize the application profile");
  }
  return promoteAllowlistedAdmin(afterConflict);
}

async function promoteAllowlistedAdmin(user: AppUser): Promise<AppUser> {
  const adminEmails = new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (user.role === "admin" || !adminEmails.has(user.email.toLowerCase())) {
    return user;
  }

  const [updated] = await db
    .update(appUsersTable)
    .set({ role: "admin" })
    .where(eq(appUsersTable.id, user.id))
    .returning();
  return updated ?? user;
}

export async function writeActivity(input: {
  actorId?: string | null;
  title: string;
  detail: string;
  type: string;
  status?: string | null;
  entityType?: string | null;
  entityId?: string | number | null;
}): Promise<void> {
  await db.insert(activityEventsTable).values({
    actorId: input.actorId ?? null,
    title: input.title,
    detail: input.detail,
    type: input.type,
    status: input.status ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId == null ? null : String(input.entityId),
  });
}

export async function writeAudit(input: {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLogsTable).values({
    actorId: input.actorId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId == null ? null : String(input.entityId),
    metadata: input.metadata,
  });
}

export async function getLatestActivity(actorId: string, limit = 8) {
  return db
    .select()
    .from(activityEventsTable)
    .where(eq(activityEventsTable.actorId, actorId))
    .orderBy(desc(activityEventsTable.createdAt))
    .limit(limit);
}

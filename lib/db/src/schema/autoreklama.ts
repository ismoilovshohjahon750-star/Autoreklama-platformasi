import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const money = (name: string) =>
  numeric(name, { precision: 16, scale: 6, mode: "number" });

export const appUsersTable = pgTable("autoreklama_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  role: text("role").notNull().default("advertiser"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const projectsTable = pgTable(
  "autoreklama_projects",
  {
    id: serial("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => appUsersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("autoreklama_projects_owner_idx").on(table.ownerId)],
);

export const campaignsTable = pgTable(
  "autoreklama_campaigns",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    headline: text("headline").notNull(),
    body: text("body").notNull(),
    targetUrl: text("target_url").notNull(),
    imageUrl: text("image_url"),
    monthlyFee: money("monthly_fee").notNull(),
    clickPrice: money("click_price").notNull(),
    status: text("status").notNull().default("pending_review"),
    moderationNote: text("moderation_note"),
    startsAt: timestamp("starts_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("autoreklama_campaigns_project_idx").on(table.projectId),
    index("autoreklama_campaigns_status_idx").on(table.status),
  ],
);

export const placementsTable = pgTable(
  "autoreklama_placements",
  {
    id: serial("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => appUsersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    address: text("address").notNull(),
    status: text("status").notNull().default("pending"),
    publicKey: text("public_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("autoreklama_placements_public_key_idx").on(table.publicKey),
    index("autoreklama_placements_owner_idx").on(table.ownerId),
  ],
);

export const impressionsTable = pgTable(
  "autoreklama_impressions",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => campaignsTable.id, { onDelete: "cascade" }),
    placementId: integer("placement_id")
      .notNull()
      .references(() => placementsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("autoreklama_impressions_campaign_idx").on(
      table.campaignId,
      table.createdAt,
    ),
    index("autoreklama_impressions_placement_idx").on(
      table.placementId,
      table.createdAt,
    ),
  ],
);

export const clicksTable = pgTable(
  "autoreklama_clicks",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => campaignsTable.id, { onDelete: "cascade" }),
    placementId: integer("placement_id")
      .notNull()
      .references(() => placementsTable.id, { onDelete: "cascade" }),
    ipHash: text("ip_hash").notNull(),
    deviceHash: text("device_hash").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull().default("pending"),
    clickPrice: money("click_price").notNull(),
    publisherShare: money("publisher_share").notNull(),
    platformShare: money("platform_share").notNull(),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("autoreklama_clicks_campaign_idx").on(
      table.campaignId,
      table.createdAt,
    ),
    index("autoreklama_clicks_placement_idx").on(
      table.placementId,
      table.createdAt,
    ),
    index("autoreklama_clicks_dedupe_idx").on(
      table.campaignId,
      table.placementId,
      table.dedupeKey,
      table.createdAt,
    ),
  ],
);

export const transactionsTable = pgTable(
  "autoreklama_transactions",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").references(() => appUsersTable.id, {
      onDelete: "set null",
    }),
    clickId: integer("click_id").references(() => clicksTable.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    amount: money("amount").notNull(),
    currency: text("currency").notNull().default("USD"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("autoreklama_transactions_user_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

export const activityEventsTable = pgTable(
  "autoreklama_activity_events",
  {
    id: serial("id").primaryKey(),
    actorId: text("actor_id").references(() => appUsersTable.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    type: text("type").notNull(),
    status: text("status"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("autoreklama_activity_actor_idx").on(
      table.actorId,
      table.createdAt,
    ),
  ],
);

export const auditLogsTable = pgTable(
  "autoreklama_audit_logs",
  {
    id: serial("id").primaryKey(),
    actorId: text("actor_id").references(() => appUsersTable.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("autoreklama_audit_actor_idx").on(table.actorId, table.createdAt),
  ],
);

export const platformSettingsTable = pgTable("autoreklama_platform_settings", {
  id: serial("id").primaryKey(),
  defaultMonthlyFee: money("default_monthly_fee").notNull().default(20),
  defaultClickPrice: money("default_click_price").notNull().default(0.1),
  publisherSharePercent: numeric("publisher_share_percent", {
    precision: 5,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(25),
  unusedBudgetPolicy: text("unused_budget_policy").notNull().default("expire"),
  payoutSchedule: text("payout_schedule").notNull().default("monthly"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const payoutRecordsTable = pgTable("autoreklama_payouts", {
  id: serial("id").primaryKey(),
  publisherId: text("publisher_id")
    .notNull()
    .references(() => appUsersTable.id, { onDelete: "cascade" }),
  amount: money("amount").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const userFlagsTable = pgTable("autoreklama_user_flags", {
  id: serial("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => appUsersTable.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  blocked: boolean("blocked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AppUser = typeof appUsersTable.$inferSelect;

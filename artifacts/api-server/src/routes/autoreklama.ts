import { randomBytes } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  sql,
} from "drizzle-orm";
import {
  CreateCampaignBody,
  CreateCampaignResponse,
  CreatePlacementBody,
  CreatePlacementResponse,
  CreateProjectBody,
  CreateProjectResponse,
  DeleteCampaignParams,
  DeletePlacementParams,
  DeleteProjectParams,
  GetAnalyticsQueryParams,
  GetAnalyticsResponse,
  GetCampaignParams,
  GetCampaignResponse,
  GetDashboardActivityResponse,
  GetDashboardSummaryResponse,
  GetMeResponse,
  GetPlatformSettingsResponse,
  ListCampaignsQueryParams,
  ListCampaignsResponse,
  ListModerationQueueResponse,
  ListPendingPlacementsResponse,
  ListPlacementsResponse,
  ListProjectsResponse,
  ReviewCampaignBody,
  ReviewCampaignParams,
  ReviewCampaignResponse,
  ReviewPlacementBody,
  ReviewPlacementParams,
  ReviewPlacementResponse,
  UpdateCampaignBody,
  UpdateCampaignParams,
  UpdateCampaignResponse,
  UpdateMeBody,
  UpdateMeResponse,
  UpdatePlacementBody,
  UpdatePlacementParams,
  UpdatePlacementResponse,
  UpdatePlatformSettingsBody,
  UpdatePlatformSettingsResponse,
  UpdateProjectBody,
  UpdateProjectParams,
  UpdateProjectResponse,
} from "@workspace/api-zod";
import {
  activityEventsTable,
  appUsersTable,
  auditLogsTable,
  campaignsTable,
  clicksTable,
  db,
  impressionsTable,
  placementsTable,
  platformSettingsTable,
  projectsTable,
  transactionsTable,
} from "@workspace/db";
import { ensureAppUser, writeActivity, writeAudit } from "../lib/autoreklama";
import {
  getActiveCampaignCount,
  getCampaignDto,
  getCampaignScope,
  getDailyTrend,
  getEventCounts,
  getPendingReviewCount,
  getPlacementDto,
  getPlacementScope,
  getRevenueTotals,
} from "../lib/queries";
import { requireRole } from "../middlewares/auth";

const router: IRouter = Router();

function requestUserId(req: { userId?: string }): string {
  if (!req.userId) {
    throw new Error("Authenticated request has no user id");
  }
  return req.userId;
}

function safeHttpUrl(value: string | null | undefined): boolean {
  if (!value) {
    return true;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

async function ensureSettings() {
  await db
    .insert(platformSettingsTable)
    .values({ id: 1 })
    .onConflictDoNothing();
  const [settings] = await db
    .select()
    .from(platformSettingsTable)
    .where(eq(platformSettingsTable.id, 1))
    .limit(1);
  if (!settings) {
    throw new Error("Platform pricing settings could not be loaded");
  }
  return settings;
}

function settingsDto(settings: typeof platformSettingsTable.$inferSelect) {
  return {
    defaultMonthlyFee: settings.defaultMonthlyFee,
    defaultClickPrice: settings.defaultClickPrice,
    publisherSharePercent: settings.publisherSharePercent,
    platformSharePercent: 100 - settings.publisherSharePercent,
    unusedBudgetPolicy: settings.unusedBudgetPolicy,
    payoutSchedule: settings.payoutSchedule,
  };
}

async function loadCampaignForUser(id: number, userId: string) {
  const [row] = await db
    .select({
      campaign: campaignsTable,
      projectName: projectsTable.name,
      ownerId: projectsTable.ownerId,
    })
    .from(campaignsTable)
    .innerJoin(projectsTable, eq(projectsTable.id, campaignsTable.projectId))
    .where(eq(campaignsTable.id, id))
    .limit(1);
  if (!row || (row.ownerId !== userId && row.ownerId !== "__admin__")) {
    return null;
  }
  return row;
}

router.get("/me", async (req, res): Promise<void> => {
  const user = await ensureAppUser(requestUserId(req));
  res.json(
    GetMeResponse.parse({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    }),
  );
});

router.patch("/me", async (req, res): Promise<void> => {
  const parsed = UpdateMeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = await ensureAppUser(requestUserId(req));
  if (user.status !== "active") {
    res.status(403).json({ error: "Hisob vaqtincha bloklangan" });
    return;
  }

  if (parsed.data.role !== user.role) {
    const [resource] =
      parsed.data.role === "publisher"
        ? await db
            .select({ id: campaignsTable.id })
            .from(campaignsTable)
            .innerJoin(
              projectsTable,
              eq(projectsTable.id, campaignsTable.projectId),
            )
            .where(eq(projectsTable.ownerId, user.id))
            .limit(1)
        : await db
            .select({ id: placementsTable.id })
            .from(placementsTable)
            .where(eq(placementsTable.ownerId, user.id))
            .limit(1);
    if (resource) {
      res.status(409).json({
        error: "Rolni o‘zgartirishdan oldin mavjud loyihalar yoki joylashuvlarni tozalang",
      });
      return;
    }
  }

  const [updated] = await db
    .update(appUsersTable)
    .set({ name: parsed.data.name, role: parsed.data.role })
    .where(eq(appUsersTable.id, user.id))
    .returning();
  res.json(
    UpdateMeResponse.parse({
      id: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
      status: updated.status,
      createdAt: updated.createdAt,
    }),
  );
});

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const user = await ensureAppUser(requestUserId(req));
  const campaignIds =
    user.role === "admin" || user.role === "publisher"
      ? null
      : await getCampaignScope(user);
  const placementIds =
    user.role === "admin" || user.role === "advertiser"
      ? null
      : await getPlacementScope(user);
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 6);
  since.setUTCHours(0, 0, 0, 0);
  const [counts, trend, revenue] = await Promise.all([
    getEventCounts(campaignIds, placementIds),
    getDailyTrend(campaignIds, placementIds, since),
    getRevenueTotals(user),
  ]);
  const activeCampaigns =
    user.role === "publisher"
      ? 0
      : await getActiveCampaignCount(campaignIds);
  const pendingReviews =
    user.role === "publisher"
      ? 0
      : await getPendingReviewCount(user, campaignIds);

  res.json(
    GetDashboardSummaryResponse.parse({
      role: user.role,
      activeCampaigns,
      ...counts,
      ...revenue,
      clickRate:
        counts.impressions > 0
          ? (counts.clicks / counts.impressions) * 100
          : 0,
      pendingReviews,
      trend,
    }),
  );
});

router.get("/dashboard/activity", async (req, res): Promise<void> => {
  const user = await ensureAppUser(requestUserId(req));
  const rows = await db
    .select()
    .from(activityEventsTable)
    .where(eq(activityEventsTable.actorId, user.id))
    .orderBy(desc(activityEventsTable.createdAt))
    .limit(12);
  res.json(
    GetDashboardActivityResponse.parse(
      rows.map((event) => ({
        id: String(event.id),
        title: event.title,
        detail: event.detail,
        type: event.type,
        status: event.status,
        createdAt: event.createdAt,
      })),
    ),
  );
});

router.get("/projects", async (req, res): Promise<void> => {
  const user = await ensureAppUser(requestUserId(req));
  if (user.role !== "advertiser" && user.role !== "admin") {
    res.json(ListProjectsResponse.parse([]));
    return;
  }
  const rows = await db
    .select()
    .from(projectsTable)
    .where(
      user.role === "admin"
        ? undefined
        : eq(projectsTable.ownerId, user.id),
    )
    .orderBy(desc(projectsTable.createdAt));
  const projects = await Promise.all(
    rows.map(async (project) => {
      const [campaignCount] = await db
        .select({ total: count() })
        .from(campaignsTable)
        .where(eq(campaignsTable.projectId, project.id));
      return {
        id: project.id,
        ownerId: project.ownerId,
        name: project.name,
        description: project.description,
        status: project.status,
        campaignCount: campaignCount?.total ?? 0,
        createdAt: project.createdAt,
      };
    }),
  );
  res.json(ListProjectsResponse.parse(projects));
});

router.post(
  "/projects",
  requireRole("advertiser"),
  async (req, res): Promise<void> => {
    const parsed = CreateProjectBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const user = await ensureAppUser(requestUserId(req));
    const [project] = await db
      .insert(projectsTable)
      .values({
        ownerId: user.id,
        name: parsed.data.name,
        description: parsed.data.description ?? "",
      })
      .returning();
    await Promise.all([
      writeActivity({
        actorId: user.id,
        title: "Yangi loyiha yaratildi",
        detail: project.name,
        type: "campaign",
        status: "active",
        entityType: "project",
        entityId: project.id,
      }),
      writeAudit({
        actorId: user.id,
        action: "project.created",
        entityType: "project",
        entityId: project.id,
      }),
    ]);
    res
      .status(201)
      .json(
        CreateProjectResponse.parse({
          ...project,
          campaignCount: 0,
        }),
      );
  },
);

router.patch("/projects/:id", async (req, res): Promise<void> => {
  const params = UpdateProjectParams.safeParse(req.params);
  const body = UpdateProjectBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: !params.success
        ? params.error.message
        : (body.error?.message ?? "Noto‘g‘ri ma’lumot"),
    });
    return;
  }
  const user = await ensureAppUser(requestUserId(req));
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, params.data.id))
    .limit(1);
  if (!project || (project.ownerId !== user.id && user.role !== "admin")) {
    res.status(404).json({ error: "Loyiha topilmadi" });
    return;
  }
  if (user.role !== "admin" && user.role !== "advertiser") {
    res.status(403).json({ error: "Bu amal uchun ruxsat yo‘q" });
    return;
  }
  const [updated] = await db
    .update(projectsTable)
    .set(body.data)
    .where(eq(projectsTable.id, project.id))
    .returning();
  const [campaignCount] = await db
    .select({ total: count() })
    .from(campaignsTable)
    .where(eq(campaignsTable.projectId, updated.id));
  await writeAudit({
    actorId: user.id,
    action: "project.updated",
    entityType: "project",
    entityId: updated.id,
    metadata: body.data,
  });
  res.json(
    UpdateProjectResponse.parse({
      ...updated,
      campaignCount: campaignCount?.total ?? 0,
    }),
  );
});

router.delete("/projects/:id", async (req, res): Promise<void> => {
  const params = DeleteProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const user = await ensureAppUser(requestUserId(req));
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, params.data.id))
    .limit(1);
  if (!project || (project.ownerId !== user.id && user.role !== "admin")) {
    res.status(404).json({ error: "Loyiha topilmadi" });
    return;
  }
  const [campaign] = await db
    .select({ id: campaignsTable.id })
    .from(campaignsTable)
    .where(eq(campaignsTable.projectId, project.id))
    .limit(1);
  if (campaign) {
    res.status(409).json({
      error: "Loyihani o‘chirishdan oldin undagi kampaniyalarni alohida olib tashlang",
    });
    return;
  }
  await db.delete(projectsTable).where(eq(projectsTable.id, project.id));
  await writeAudit({
    actorId: user.id,
    action: "project.deleted",
    entityType: "project",
    entityId: project.id,
  });
  res.sendStatus(204);
});

router.get("/campaigns", async (req, res): Promise<void> => {
  const params = ListCampaignsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const user = await ensureAppUser(requestUserId(req));
  if (user.role === "publisher") {
    res.json(ListCampaignsResponse.parse([]));
    return;
  }
  const conditions = [];
  if (user.role !== "admin") {
    conditions.push(eq(projectsTable.ownerId, user.id));
  }
  if (params.data.projectId) {
    conditions.push(eq(campaignsTable.projectId, params.data.projectId));
  }
  if (params.data.status) {
    conditions.push(eq(campaignsTable.status, params.data.status));
  }
  const rows = await db
    .select({ campaign: campaignsTable, projectName: projectsTable.name })
    .from(campaignsTable)
    .innerJoin(projectsTable, eq(projectsTable.id, campaignsTable.projectId))
    .where(and(...conditions))
    .orderBy(desc(campaignsTable.createdAt));
  const result = await Promise.all(
    rows.map(({ campaign, projectName }) =>
      getCampaignDto(campaign, projectName),
    ),
  );
  res.json(ListCampaignsResponse.parse(result));
});

router.post(
  "/campaigns",
  requireRole("advertiser"),
  async (req, res): Promise<void> => {
    const parsed = CreateCampaignBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (
      !safeHttpUrl(parsed.data.targetUrl) ||
      !safeHttpUrl(parsed.data.imageUrl)
    ) {
      res.status(400).json({ error: "Faqat http va https havolalari ruxsat etiladi" });
      return;
    }
    const user = await ensureAppUser(requestUserId(req));
    const [project] = await db
      .select()
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.id, parsed.data.projectId),
          eq(projectsTable.ownerId, user.id),
          eq(projectsTable.status, "active"),
        ),
      )
      .limit(1);
    if (!project) {
      res.status(404).json({ error: "Faol loyiha topilmadi" });
      return;
    }

    const startsAt = parsed.data.startsAt
      ? new Date(parsed.data.startsAt)
      : new Date();
    const endsAt =
      parsed.data.endsAt === null
        ? null
        : parsed.data.endsAt
          ? new Date(parsed.data.endsAt)
          : new Date(startsAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    if (endsAt && endsAt <= startsAt) {
      res.status(400).json({ error: "Kampaniya tugash sanasi boshlanish sanasidan keyin bo‘lishi kerak" });
      return;
    }

    const [campaign] = await db
      .insert(campaignsTable)
      .values({
        projectId: project.id,
        name: parsed.data.name,
        headline: parsed.data.headline,
        body: parsed.data.body,
        targetUrl: parsed.data.targetUrl,
        imageUrl: parsed.data.imageUrl ?? null,
        monthlyFee: parsed.data.monthlyFee,
        clickPrice: parsed.data.clickPrice,
        status: "pending_review",
        startsAt,
        endsAt,
      })
      .returning();
    await Promise.all([
      writeActivity({
        actorId: user.id,
        title: "Kampaniya moderatsiyaga yuborildi",
        detail: campaign.name,
        type: "campaign",
        status: "pending_review",
        entityType: "campaign",
        entityId: campaign.id,
      }),
      writeAudit({
        actorId: user.id,
        action: "campaign.created",
        entityType: "campaign",
        entityId: campaign.id,
      }),
    ]);
    res
      .status(201)
      .json(CreateCampaignResponse.parse(await getCampaignDto(campaign, project.name)));
  },
);

router.get("/campaigns/:id", async (req, res): Promise<void> => {
  const params = GetCampaignParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const user = await ensureAppUser(requestUserId(req));
  if (user.role === "publisher") {
    res.status(403).json({ error: "Bu kampaniya sizga tegishli emas" });
    return;
  }
  const [row] = await db
    .select({ campaign: campaignsTable, projectName: projectsTable.name, ownerId: projectsTable.ownerId })
    .from(campaignsTable)
    .innerJoin(projectsTable, eq(projectsTable.id, campaignsTable.projectId))
    .where(eq(campaignsTable.id, params.data.id))
    .limit(1);
  if (!row || (row.ownerId !== user.id && user.role !== "admin")) {
    res.status(404).json({ error: "Kampaniya topilmadi" });
    return;
  }
  res.json(
    GetCampaignResponse.parse(
      await getCampaignDto(row.campaign, row.projectName),
    ),
  );
});

router.patch("/campaigns/:id", async (req, res): Promise<void> => {
  const params = UpdateCampaignParams.safeParse(req.params);
  const body = UpdateCampaignBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: !params.success
        ? params.error.message
        : (body.error?.message ?? "Noto‘g‘ri ma’lumot"),
    });
    return;
  }
  const user = await ensureAppUser(requestUserId(req));
  if (user.role !== "advertiser" && user.role !== "admin") {
    res.status(403).json({ error: "Bu amal uchun ruxsat yo‘q" });
    return;
  }
  const [row] = await db
    .select({ campaign: campaignsTable, projectName: projectsTable.name, ownerId: projectsTable.ownerId })
    .from(campaignsTable)
    .innerJoin(projectsTable, eq(projectsTable.id, campaignsTable.projectId))
    .where(eq(campaignsTable.id, params.data.id))
    .limit(1);
  if (!row || (row.ownerId !== user.id && user.role !== "admin")) {
    res.status(404).json({ error: "Kampaniya topilmadi" });
    return;
  }
  if (
    body.data.targetUrl !== undefined &&
    !safeHttpUrl(body.data.targetUrl)
  ) {
    res.status(400).json({ error: "Faqat http va https havolalari ruxsat etiladi" });
    return;
  }
  if (!["draft", "paused", "rejected"].includes(row.campaign.status)) {
    const hasCreativeEdit =
      body.data.headline !== undefined ||
      body.data.body !== undefined ||
      body.data.targetUrl !== undefined ||
      body.data.name !== undefined;
    if (hasCreativeEdit) {
      res.status(409).json({
        error: "Reklama matnini tahrirlash uchun kampaniyani avval pauzaga qo‘ying",
      });
      return;
    }
  }
  const next: Partial<typeof campaignsTable.$inferInsert> = {
    ...body.data,
  };
  const hasCreativeEdit =
    next.headline !== undefined ||
    next.body !== undefined ||
    next.targetUrl !== undefined ||
    next.name !== undefined;
  if (hasCreativeEdit) {
    next.status = "pending_review";
    next.moderationNote = null;
  }

  if (next.monthlyFee !== undefined) {
    const [spent] = await db
      .select({
        total: sql<number>`coalesce(sum(${clicksTable.clickPrice}), 0)`,
      })
      .from(clicksTable)
      .where(
        and(
          eq(clicksTable.campaignId, row.campaign.id),
          eq(clicksTable.status, "verified"),
        ),
      );
    if (next.monthlyFee + 0.0000001 < Number(spent?.total ?? 0)) {
      res.status(409).json({
        error: "Oylik byudjet sarflangan mablag‘dan kam bo‘lishi mumkin emas",
      });
      return;
    }
  }

  const [updated] = await db
    .update(campaignsTable)
    .set(next)
    .where(eq(campaignsTable.id, row.campaign.id))
    .returning();
  await Promise.all([
    writeActivity({
      actorId: user.id,
      title: hasCreativeEdit ? "Reklama qayta moderatsiyaga yuborildi" : "Kampaniya yangilandi",
      detail: updated.name,
      type: "campaign",
      status: updated.status,
      entityType: "campaign",
      entityId: updated.id,
    }),
    writeAudit({
      actorId: user.id,
      action: "campaign.updated",
      entityType: "campaign",
      entityId: updated.id,
      metadata: next,
    }),
  ]);
  res.json(
    UpdateCampaignResponse.parse(
      await getCampaignDto(updated, row.projectName),
    ),
  );
});

router.delete("/campaigns/:id", async (req, res): Promise<void> => {
  const params = DeleteCampaignParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const user = await ensureAppUser(requestUserId(req));
  const [row] = await db
    .select({ campaign: campaignsTable, ownerId: projectsTable.ownerId })
    .from(campaignsTable)
    .innerJoin(projectsTable, eq(projectsTable.id, campaignsTable.projectId))
    .where(eq(campaignsTable.id, params.data.id))
    .limit(1);
  if (!row || (row.ownerId !== user.id && user.role !== "admin")) {
    res.status(404).json({ error: "Kampaniya topilmadi" });
    return;
  }
  if (row.campaign.status !== "draft") {
    res.status(409).json({ error: "Faqat qoralama kampaniyalarni o‘chirish mumkin" });
    return;
  }
  await db.delete(campaignsTable).where(eq(campaignsTable.id, row.campaign.id));
  await writeAudit({
    actorId: user.id,
    action: "campaign.deleted",
    entityType: "campaign",
    entityId: row.campaign.id,
  });
  res.sendStatus(204);
});

router.get("/placements", async (req, res): Promise<void> => {
  const user = await ensureAppUser(requestUserId(req));
  const rows = await db
    .select()
    .from(placementsTable)
    .where(
      user.role === "admin"
        ? undefined
        : eq(placementsTable.ownerId, user.id),
    )
    .orderBy(desc(placementsTable.createdAt));
  const result = await Promise.all(
    rows.map(getPlacementDto),
  );
  res.json(ListPlacementsResponse.parse(result));
});

router.post(
  "/placements",
  requireRole("publisher"),
  async (req, res): Promise<void> => {
    const parsed = CreatePlacementBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const user = await ensureAppUser(requestUserId(req));
    const publicKey = `pub_${randomBytes(24).toString("hex")}`;
    const [placement] = await db
      .insert(placementsTable)
      .values({
        ownerId: user.id,
        name: parsed.data.name,
        type: parsed.data.type,
        address: parsed.data.address,
        status: "pending",
        publicKey,
      })
      .returning();
    await Promise.all([
      writeActivity({
        actorId: user.id,
        title: "Joylashuv moderatsiyaga yuborildi",
        detail: placement.name,
        type: "placement",
        status: "pending",
        entityType: "placement",
        entityId: placement.id,
      }),
      writeAudit({
        actorId: user.id,
        action: "placement.created",
        entityType: "placement",
        entityId: placement.id,
        metadata: { type: placement.type },
      }),
    ]);
    res
      .status(201)
      .json(
        CreatePlacementResponse.parse({
          ...placement,
          impressions: 0,
          clicks: 0,
          verifiedClicks: 0,
        }),
      );
  },
);

router.patch("/placements/:id", async (req, res): Promise<void> => {
  const params = UpdatePlacementParams.safeParse(req.params);
  const body = UpdatePlacementBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: !params.success
        ? params.error.message
        : (body.error?.message ?? "Noto‘g‘ri ma’lumot"),
    });
    return;
  }
  const user = await ensureAppUser(requestUserId(req));
  const [placement] = await db
    .select()
    .from(placementsTable)
    .where(eq(placementsTable.id, params.data.id))
    .limit(1);
  if (!placement || (placement.ownerId !== user.id && user.role !== "admin")) {
    res.status(404).json({ error: "Joylashuv topilmadi" });
    return;
  }
  if (user.role !== "publisher" && user.role !== "admin") {
    res.status(403).json({ error: "Bu amal uchun ruxsat yo‘q" });
    return;
  }
  const [updated] = await db
    .update(placementsTable)
    .set(body.data)
    .where(eq(placementsTable.id, placement.id))
    .returning();
  const [impressions] = await db
    .select({ total: count() })
    .from(impressionsTable)
    .where(eq(impressionsTable.placementId, placement.id));
  const [clicks] = await db
    .select({
      total: count(),
      verified: sql<number>`count(*) filter (where ${clicksTable.status} = 'verified')`,
    })
    .from(clicksTable)
    .where(eq(clicksTable.placementId, placement.id));
  await writeAudit({
    actorId: user.id,
    action: "placement.updated",
    entityType: "placement",
    entityId: placement.id,
  });
  res.json(
    UpdatePlacementResponse.parse({
      ...updated,
      impressions: impressions?.total ?? 0,
      clicks: Number(clicks?.total ?? 0),
      verifiedClicks: Number(clicks?.verified ?? 0),
    }),
  );
});

router.delete("/placements/:id", async (req, res): Promise<void> => {
  const params = DeletePlacementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const user = await ensureAppUser(requestUserId(req));
  const [placement] = await db
    .select()
    .from(placementsTable)
    .where(eq(placementsTable.id, params.data.id))
    .limit(1);
  if (!placement || (placement.ownerId !== user.id && user.role !== "admin")) {
    res.status(404).json({ error: "Joylashuv topilmadi" });
    return;
  }
  const [history] = await db
    .select({ id: impressionsTable.id })
    .from(impressionsTable)
    .where(eq(impressionsTable.placementId, placement.id))
    .limit(1);
  const [clickHistory] = await db
    .select({ id: clicksTable.id })
    .from(clicksTable)
    .where(eq(clicksTable.placementId, placement.id))
    .limit(1);
  if (history || clickHistory) {
    res.status(409).json({
      error: "Statistika tarixi bor joylashuv o‘chirilmaydi; uni pauzaga qo‘ying",
    });
    return;
  }
  await db.delete(placementsTable).where(eq(placementsTable.id, placement.id));
  await writeAudit({
    actorId: user.id,
    action: "placement.deleted",
    entityType: "placement",
    entityId: placement.id,
  });
  res.sendStatus(204);
});

router.get(
  "/admin/placements",
  requireRole("admin"),
  async (_req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(placementsTable)
      .where(eq(placementsTable.status, "pending"))
      .orderBy(desc(placementsTable.createdAt));
    res.json(
      ListPendingPlacementsResponse.parse(
        await Promise.all(rows.map(getPlacementDto)),
      ),
    );
  },
);

router.patch(
  "/admin/placements/:id",
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const params = ReviewPlacementParams.safeParse(req.params);
    const body = ReviewPlacementBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: !params.success
          ? params.error.message
          : (body.error?.message ?? "Noto‘g‘ri ma’lumot"),
      });
      return;
    }
    const admin = await ensureAppUser(requestUserId(req));
    const [placement] = await db
      .select()
      .from(placementsTable)
      .where(eq(placementsTable.id, params.data.id))
      .limit(1);
    if (!placement || placement.status !== "pending") {
      res.status(404).json({ error: "Tasdiqlash navbatidagi joylashuv topilmadi" });
      return;
    }
    const status = body.data.decision === "approve" ? "approved" : "rejected";
    const [updated] = await db
      .update(placementsTable)
      .set({ status })
      .where(eq(placementsTable.id, placement.id))
      .returning();
    await Promise.all([
      writeActivity({
        actorId: placement.ownerId,
        title:
          status === "approved"
            ? "Joylashuv tasdiqlandi"
            : "Joylashuv rad etildi",
        detail: placement.name,
        type: "placement",
        status,
        entityType: "placement",
        entityId: placement.id,
      }),
      writeAudit({
        actorId: admin.id,
        action: `placement.${status}`,
        entityType: "placement",
        entityId: placement.id,
        metadata: { note: body.data.note ?? null },
      }),
    ]);
    res.json(
      ReviewPlacementResponse.parse(await getPlacementDto(updated)),
    );
  },
);

router.get("/analytics", async (req, res): Promise<void> => {
  const params = GetAnalyticsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const user = await ensureAppUser(requestUserId(req));
  const campaignIds =
    user.role === "admin" || user.role === "publisher"
      ? null
      : await getCampaignScope(user);
  const placementIds =
    user.role === "admin" || user.role === "advertiser"
      ? null
      : await getPlacementScope(user);
  const days = Number.parseInt(params.data.range, 10);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [counts, trend, revenue] = await Promise.all([
    getEventCounts(campaignIds, placementIds, since),
    getDailyTrend(campaignIds, placementIds, since),
    getRevenueTotals(user),
  ]);
  let topCampaigns: Awaited<ReturnType<typeof getCampaignDto>>[] = [];
  if (user.role === "admin" || user.role === "advertiser") {
    const rows = await db
      .select({ campaign: campaignsTable, projectName: projectsTable.name })
      .from(campaignsTable)
      .innerJoin(projectsTable, eq(projectsTable.id, campaignsTable.projectId))
      .where(
        and(
          user.role === "admin"
            ? undefined
            : eq(projectsTable.ownerId, user.id),
        ),
      )
      .orderBy(desc(campaignsTable.createdAt))
      .limit(5);
    topCampaigns = await Promise.all(
      rows.map(({ campaign, projectName }) =>
        getCampaignDto(campaign, projectName),
      ),
    );
  }

  res.json(
    GetAnalyticsResponse.parse({
      range: params.data.range,
      ...counts,
      ...revenue,
      clickRate:
        counts.impressions > 0
          ? (counts.clicks / counts.impressions) * 100
          : 0,
      trend,
      topCampaigns,
    }),
  );
});

router.get(
  "/admin/moderation",
  requireRole("admin"),
  async (_req, res): Promise<void> => {
    const rows = await db
      .select({
        campaign: campaignsTable,
        projectName: projectsTable.name,
        advertiserName: appUsersTable.name,
      })
      .from(campaignsTable)
      .innerJoin(projectsTable, eq(projectsTable.id, campaignsTable.projectId))
      .innerJoin(appUsersTable, eq(appUsersTable.id, projectsTable.ownerId))
      .where(eq(campaignsTable.status, "pending_review"))
      .orderBy(desc(campaignsTable.createdAt));
    const result = await Promise.all(
      rows.map(async (row) => ({
        campaign: await getCampaignDto(row.campaign, row.projectName),
        advertiserName: row.advertiserName,
      })),
    );
    res.json(ListModerationQueueResponse.parse(result));
  },
);

router.patch(
  "/admin/moderation/:id",
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const params = ReviewCampaignParams.safeParse(req.params);
    const body = ReviewCampaignBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: !params.success
          ? params.error.message
          : (body.error?.message ?? "Noto‘g‘ri ma’lumot"),
      });
      return;
    }
    const admin = await ensureAppUser(requestUserId(req));
    const [row] = await db
      .select({
        campaign: campaignsTable,
        projectName: projectsTable.name,
        ownerId: projectsTable.ownerId,
      })
      .from(campaignsTable)
      .innerJoin(projectsTable, eq(projectsTable.id, campaignsTable.projectId))
      .where(eq(campaignsTable.id, params.data.id))
      .limit(1);
    if (!row || row.campaign.status !== "pending_review") {
      res.status(404).json({ error: "Moderatsiya navbatidagi kampaniya topilmadi" });
      return;
    }
    const status = body.data.decision === "approve" ? "active" : "rejected";
    const [updated] = await db
      .update(campaignsTable)
      .set({
        status,
        moderationNote: body.data.note?.trim() || null,
      })
      .where(eq(campaignsTable.id, row.campaign.id))
      .returning();
    await Promise.all([
      writeActivity({
        actorId: row.ownerId,
        title:
          status === "active"
            ? "Kampaniya tasdiqlandi"
            : "Kampaniya rad etildi",
        detail: updated.name,
        type: "moderation",
        status,
        entityType: "campaign",
        entityId: updated.id,
      }),
      writeActivity({
        actorId: admin.id,
        title: "Moderatsiya yakunlandi",
        detail: updated.name,
        type: "moderation",
        status,
        entityType: "campaign",
        entityId: updated.id,
      }),
      writeAudit({
        actorId: admin.id,
        action: `campaign.${status}`,
        entityType: "campaign",
        entityId: updated.id,
        metadata: { note: body.data.note ?? null },
      }),
    ]);
    res.json(
      ReviewCampaignResponse.parse(
        await getCampaignDto(updated, row.projectName),
      ),
    );
  },
);

router.get("/admin/settings", async (_req, res): Promise<void> => {
  const settings = await ensureSettings();
  res.json(GetPlatformSettingsResponse.parse(settingsDto(settings)));
});

router.patch(
  "/admin/settings",
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const parsed = UpdatePlatformSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const admin = await ensureAppUser(requestUserId(req));
    await ensureSettings();
    const [updated] = await db
      .update(platformSettingsTable)
      .set(parsed.data)
      .where(eq(platformSettingsTable.id, 1))
      .returning();
    await Promise.all([
      writeActivity({
        actorId: admin.id,
        title: "Platform tariflari yangilandi",
        detail: `Hamkor ulushi: ${updated.publisherSharePercent}%`,
        type: "moderation",
        status: "updated",
        entityType: "settings",
        entityId: 1,
      }),
      writeAudit({
        actorId: admin.id,
        action: "settings.updated",
        entityType: "settings",
        entityId: 1,
        metadata: parsed.data,
      }),
    ]);
    res.json(
      UpdatePlatformSettingsResponse.parse(settingsDto(updated)),
    );
  },
);

export default router;

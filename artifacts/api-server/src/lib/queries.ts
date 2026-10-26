import { and, count, eq, inArray, sql, sum } from "drizzle-orm";
import {
  campaignsTable,
  clicksTable,
  db,
  impressionsTable,
  placementsTable,
  projectsTable,
  transactionsTable,
  type AppUser,
} from "@workspace/db";

export async function getCampaignDto(
  campaign: typeof campaignsTable.$inferSelect,
  projectName?: string,
) {
  const [project] = projectName
    ? []
    : await db
        .select({ name: projectsTable.name })
        .from(projectsTable)
        .where(eq(projectsTable.id, campaign.projectId))
        .limit(1);
  const [impressions] = await db
    .select({ total: count() })
    .from(impressionsTable)
    .where(eq(impressionsTable.campaignId, campaign.id));
  const [clickSummary] = await db
    .select({
      total: count(),
      verified: sql<number>`count(*) filter (where ${clicksTable.status} = 'verified')`,
      spent: sql<number>`coalesce(sum(${clicksTable.clickPrice}) filter (where ${clicksTable.status} = 'verified'), 0)`,
    })
    .from(clicksTable)
    .where(eq(clicksTable.campaignId, campaign.id));
  const spent = Number(clickSummary?.spent ?? 0);

  return {
    id: campaign.id,
    projectId: campaign.projectId,
    projectName: projectName ?? project?.name ?? "",
    name: campaign.name,
    headline: campaign.headline,
    body: campaign.body,
    targetUrl: campaign.targetUrl,
    imageUrl: campaign.imageUrl,
    monthlyFee: campaign.monthlyFee,
    clickPrice: campaign.clickPrice,
    budget: campaign.monthlyFee,
    spent,
    remainingBudget: Math.max(0, campaign.monthlyFee - spent),
    status: campaign.status,
    moderationNote: campaign.moderationNote,
    impressions: impressions?.total ?? 0,
    clicks: Number(clickSummary?.total ?? 0),
    verifiedClicks: Number(clickSummary?.verified ?? 0),
    startsAt: campaign.startsAt,
    endsAt: campaign.endsAt,
    createdAt: campaign.createdAt,
  };
}

export async function getPlacementDto(
  placement: typeof placementsTable.$inferSelect,
) {
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
  return {
    id: placement.id,
    ownerId: placement.ownerId,
    name: placement.name,
    type: placement.type,
    address: placement.address,
    status: placement.status,
    publicKey: placement.publicKey,
    impressions: impressions?.total ?? 0,
    clicks: Number(clicks?.total ?? 0),
    verifiedClicks: Number(clicks?.verified ?? 0),
    createdAt: placement.createdAt,
  };
}

export async function getCampaignScope(user: AppUser): Promise<number[] | null> {
  if (user.role === "admin") {
    return null;
  }
  const projects = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(eq(projectsTable.ownerId, user.id));
  return projects.map((project) => project.id);
}

export async function getPlacementScope(user: AppUser): Promise<number[] | null> {
  if (user.role === "admin") {
    return null;
  }
  const placements = await db
    .select({ id: placementsTable.id })
    .from(placementsTable)
    .where(eq(placementsTable.ownerId, user.id));
  return placements.map((placement) => placement.id);
}

export async function getEventCounts(
  campaignIds: number[] | null,
  placementIds: number[] | null,
  since?: Date,
) {
  const impressionFilter =
    campaignIds === null && placementIds === null
      ? undefined
      : campaignIds !== null
        ? inArray(impressionsTable.campaignId, campaignIds)
        : inArray(impressionsTable.placementId, placementIds ?? []);
  const clickFilter =
    campaignIds === null && placementIds === null
      ? undefined
      : campaignIds !== null
        ? inArray(clicksTable.campaignId, campaignIds)
        : inArray(clicksTable.placementId, placementIds ?? []);
  const [impressionResult] = await db
    .select({ total: count() })
    .from(impressionsTable)
    .where(
      and(
        impressionFilter,
        since ? sql`${impressionsTable.createdAt} >= ${since}` : undefined,
      ),
    );
  const [clickResult] = await db
    .select({
      total: count(),
      verified: sql<number>`count(*) filter (where ${clicksTable.status} = 'verified')`,
    })
    .from(clicksTable)
    .where(
      and(
        clickFilter,
        since ? sql`${clicksTable.createdAt} >= ${since}` : undefined,
      ),
    );

  return {
    impressions: impressionResult?.total ?? 0,
    clicks: Number(clickResult?.total ?? 0),
    verifiedClicks: Number(clickResult?.verified ?? 0),
  };
}

export async function getDailyTrend(
  campaignIds: number[] | null,
  placementIds: number[] | null,
  since: Date,
) {
  const impressionFilter =
    campaignIds === null && placementIds === null
      ? undefined
      : campaignIds !== null
        ? inArray(impressionsTable.campaignId, campaignIds)
        : inArray(impressionsTable.placementId, placementIds ?? []);
  const clickFilter =
    campaignIds === null && placementIds === null
      ? undefined
      : campaignIds !== null
        ? inArray(clicksTable.campaignId, campaignIds)
        : inArray(clicksTable.placementId, placementIds ?? []);

  const [impressions, clicks] = await Promise.all([
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${impressionsTable.createdAt}), 'YYYY-MM-DD')`,
        total: count(),
      })
      .from(impressionsTable)
      .where(
        and(
          impressionFilter,
          sql`${impressionsTable.createdAt} >= ${since}`,
        ),
      )
      .groupBy(sql`date_trunc('day', ${impressionsTable.createdAt})`),
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${clicksTable.createdAt}), 'YYYY-MM-DD')`,
        total: count(),
        verified: sql<number>`count(*) filter (where ${clicksTable.status} = 'verified')`,
      })
      .from(clicksTable)
      .where(
        and(clickFilter, sql`${clicksTable.createdAt} >= ${since}`),
      )
      .groupBy(sql`date_trunc('day', ${clicksTable.createdAt})`),
  ]);

  const byDay = new Map<
    string,
    { date: string; impressions: number; clicks: number; verifiedClicks: number }
  >();
  for (const item of impressions) {
    byDay.set(item.day, {
      date: item.day,
      impressions: item.total,
      clicks: 0,
      verifiedClicks: 0,
    });
  }
  for (const item of clicks) {
    const row = byDay.get(item.day) ?? {
      date: item.day,
      impressions: 0,
      clicks: 0,
      verifiedClicks: 0,
    };
    row.clicks = Number(item.total);
    row.verifiedClicks = Number(item.verified);
    byDay.set(item.day, row);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function getRevenueTotals(user: AppUser) {
  const isPublisher = user.role === "publisher";
  const [publisherResult, platformResult] = await Promise.all([
    db
      .select({ total: sql<number>`coalesce(sum(${transactionsTable.amount}), 0)` })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.type, "publisher_earning"),
          isPublisher ? eq(transactionsTable.userId, user.id) : undefined,
        ),
      ),
    db
      .select({ total: sql<number>`coalesce(sum(${transactionsTable.amount}), 0)` })
      .from(transactionsTable)
      .where(eq(transactionsTable.type, "platform_revenue")),
  ]);
  return {
    publisherEarnings: isPublisher
      ? Number(publisherResult[0]?.total ?? 0)
      : 0,
    platformRevenue:
      user.role === "admin" ? Number(platformResult[0]?.total ?? 0) : 0,
  };
}

export async function getActiveCampaignCount(
  campaignIds: number[] | null,
): Promise<number> {
  const [result] = await db
    .select({ total: count() })
    .from(campaignsTable)
    .where(
      and(
        eq(campaignsTable.status, "active"),
        campaignIds === null
          ? undefined
          : inArray(campaignsTable.id, campaignIds),
      ),
    );
  return result?.total ?? 0;
}

export async function getPendingReviewCount(
  user: AppUser,
  campaignIds: number[] | null,
): Promise<number> {
  const [result] = await db
    .select({ total: count() })
    .from(campaignsTable)
    .where(
      and(
        eq(campaignsTable.status, "pending_review"),
        user.role === "admin" || campaignIds === null
          ? undefined
          : inArray(campaignsTable.id, campaignIds),
      ),
    );
  return result?.total ?? 0;
}

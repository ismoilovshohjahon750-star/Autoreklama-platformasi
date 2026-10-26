import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import rateLimit from "express-rate-limit";
import { and, desc, eq, gt, gte, isNull, lte, or, sql } from "drizzle-orm";
import {
  GetSdkAdQueryParams,
  GetSdkAdResponse,
  RecordSdkClickBody,
  RecordSdkClickResponse,
  RecordSdkImpressionBody,
  RecordSdkImpressionResponse,
} from "@workspace/api-zod";
import {
  appUsersTable,
  campaignsTable,
  clicksTable,
  db,
  impressionsTable,
  placementsTable,
  platformSettingsTable,
  transactionsTable,
} from "@workspace/db";

const router: IRouter = Router();
const sdkRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 90,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: "SDK so‘rovlari limiti vaqtincha tugadi" });
  },
});

router.use("/sdk", sdkRateLimit);

function signingSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required for public SDK event signing");
  }
  return secret;
}

function hashValue(value: string, purpose: string): string {
  return createHmac("sha256", signingSecret())
    .update(`${purpose}:${value}`)
    .digest("hex");
}

function makeClickToken(campaignId: number, placementId: number): string {
  const payload = Buffer.from(
    JSON.stringify({
      campaignId,
      placementId,
      expiresAt: Date.now() + 15 * 60 * 1000,
      nonce: randomBytes(12).toString("hex"),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", signingSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifyClickToken(
  token: string,
  campaignId: number,
  placementId: number,
): boolean {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) {
    return false;
  }

  const expected = createHmac("sha256", signingSecret())
    .update(payload)
    .digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return false;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as {
      campaignId?: number;
      placementId?: number;
      expiresAt?: number;
    };
    return (
      parsed.campaignId === campaignId &&
      parsed.placementId === placementId &&
      typeof parsed.expiresAt === "number" &&
      parsed.expiresAt >= Date.now()
    );
  } catch {
    return false;
  }
}

function originMatchesPlacement(req: Request, address: string): boolean {
  const origin = req.get("origin");
  if (!origin) {
    return false;
  }
  try {
    const registeredUrl = address.includes("://")
      ? new URL(address)
      : new URL(`https://${address}`);
    const originHost = new URL(origin).hostname.toLowerCase();
    if (originHost === registeredUrl.hostname.toLowerCase()) {
      return true;
    }

    // The signed-in integrations preview is served from this platform's own
    // host, rather than the publisher's site. Allow that same-origin preview
    // while keeping arbitrary third-party origins bound to the placement.
    const platformHosts = [
      req.get("x-forwarded-host")?.split(",")[0]?.trim(),
      req.get("host"),
      process.env.REPLIT_DEV_DOMAIN,
      ...(process.env.REPLIT_DOMAINS ?? "").split(","),
    ]
      .filter((host): host is string => Boolean(host))
      .map((host) =>
        host
          .replace(/^https?:\/\//i, "")
          .split("/")[0]
          .split(":")[0]
          .trim()
          .toLowerCase(),
      );
    return platformHosts.includes(originHost);
  } catch {
    return false;
  }
}

async function findApprovedPlacement(publicKey: string) {
  const [placement] = await db
    .select()
    .from(placementsTable)
    .where(
      and(
        eq(placementsTable.publicKey, publicKey),
        eq(placementsTable.status, "approved"),
      ),
    )
    .limit(1);
  return placement;
}

async function findActiveCampaign(campaignId: number) {
  const now = new Date();
  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(
      and(
        eq(campaignsTable.id, campaignId),
        eq(campaignsTable.status, "active"),
        lte(campaignsTable.startsAt, now),
        or(isNull(campaignsTable.endsAt), gt(campaignsTable.endsAt, now)),
      ),
    )
    .limit(1);
  return campaign;
}

async function hasBudget(campaignId: number, monthlyFee: number): Promise<boolean> {
  const [result] = await db
    .select({
      spent: sql<number>`coalesce(sum(${clicksTable.clickPrice}), 0)`,
    })
    .from(clicksTable)
    .where(
      and(
        eq(clicksTable.campaignId, campaignId),
        eq(clicksTable.status, "verified"),
      ),
    );
  return Number(result?.spent ?? 0) < monthlyFee;
}

router.get("/sdk/ads", async (req, res): Promise<void> => {
  const parsed = GetSdkAdQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const placement = await findApprovedPlacement(parsed.data.placementKey);
  if (!placement || placement.type !== "web") {
    res.json(GetSdkAdResponse.parse({ ad: null }));
    return;
  }
  if (!originMatchesPlacement(req, placement.address)) {
    res.status(403).json({ error: "Bu domen uchun reklama joylashuvi tasdiqlanmagan" });
    return;
  }

  const now = new Date();
  const eligible = await db
    .select()
    .from(campaignsTable)
    .where(
      and(
        eq(campaignsTable.status, "active"),
        lte(campaignsTable.startsAt, now),
        or(isNull(campaignsTable.endsAt), gt(campaignsTable.endsAt, now)),
      ),
    )
    .orderBy(desc(campaignsTable.createdAt))
    .limit(30);

  for (const campaign of eligible) {
    if (await hasBudget(campaign.id, campaign.monthlyFee)) {
      res.json(
        GetSdkAdResponse.parse({
          ad: {
            campaignId: campaign.id,
            headline: campaign.headline,
            body: campaign.body,
            targetUrl: campaign.targetUrl,
            imageUrl: campaign.imageUrl,
            clickToken: makeClickToken(campaign.id, placement.id),
          },
        }),
      );
      return;
    }
  }

  res.json(GetSdkAdResponse.parse({ ad: null }));
});

async function validateSdkEvent(
  req: Request,
  input: {
    placementKey: string;
    campaignId: number;
    clickToken: string;
  },
) {
  const placement = await findApprovedPlacement(input.placementKey);
  if (
    !placement ||
    placement.type !== "web" ||
    !originMatchesPlacement(req, placement.address)
  ) {
    return null;
  }
  const campaign = await findActiveCampaign(input.campaignId);
  if (
    !campaign ||
    !verifyClickToken(input.clickToken, campaign.id, placement.id)
  ) {
    return null;
  }
  return { campaign, placement };
}

router.post("/sdk/impressions", async (req, res): Promise<void> => {
  const parsed = RecordSdkImpressionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const valid = await validateSdkEvent(req, parsed.data);
  if (!valid) {
    res.status(403).json({ error: "Impression manbasi tekshiruvdan o‘tmadi" });
    return;
  }

  const [impression] = await db
    .insert(impressionsTable)
    .values({
      campaignId: valid.campaign.id,
      placementId: valid.placement.id,
    })
    .returning({ id: impressionsTable.id });

  res
    .status(202)
    .json(
      RecordSdkImpressionResponse.parse({
        eventId: String(impression.id),
        status: "recorded",
        duplicate: false,
      }),
    );
});

router.post("/sdk/clicks", async (req, res): Promise<void> => {
  const parsed = RecordSdkClickBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const valid = await validateSdkEvent(req, parsed.data);
  if (!valid) {
    res.status(403).json({ error: "Klik manbasi tekshiruvdan o‘tmadi" });
    return;
  }

  const clientIp = req.ip || req.socket.remoteAddress || "unknown";
  const ipHash = hashValue(clientIp, "ip");
  const deviceHash = hashValue(parsed.data.deviceToken, "device");
  const dedupeKey = hashValue(`${ipHash}:${deviceHash}`, "dedupe");
  const [settings] = await db.select().from(platformSettingsTable).limit(1);
  const publisherSharePercent = settings?.publisherSharePercent ?? 25;
  const clickPrice = valid.campaign.clickPrice;
  const publisherShare =
    Math.round(clickPrice * (publisherSharePercent / 100) * 1_000_000) /
    1_000_000;
  const platformShare =
    Math.round((clickPrice - publisherShare) * 1_000_000) / 1_000_000;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`campaign:${valid.campaign.id}`}))`,
    );

    const [duplicate] = await tx
      .select({ id: clicksTable.id })
      .from(clicksTable)
      .where(
        and(
          eq(clicksTable.campaignId, valid.campaign.id),
          eq(clicksTable.placementId, valid.placement.id),
          eq(clicksTable.dedupeKey, dedupeKey),
          gte(clicksTable.createdAt, cutoff),
        ),
      )
      .limit(1);

    if (duplicate) {
      return { id: duplicate.id, status: "rejected" as const, duplicate: true };
    }

    const [spentResult] = await tx
      .select({
        spent: sql<number>`coalesce(sum(${clicksTable.clickPrice}), 0)`,
      })
      .from(clicksTable)
      .where(
        and(
          eq(clicksTable.campaignId, valid.campaign.id),
          eq(clicksTable.status, "verified"),
        ),
      );
    const spent = Number(spentResult?.spent ?? 0);
    const reason =
      spent + clickPrice > valid.campaign.monthlyFee + 0.0000001
        ? "Campaign budget exhausted"
        : null;
    const [inserted] = await tx
      .insert(clicksTable)
      .values({
        campaignId: valid.campaign.id,
        placementId: valid.placement.id,
        ipHash,
        deviceHash,
        dedupeKey,
        status: reason ? "rejected" : "pending",
        clickPrice,
        publisherShare,
        platformShare,
        rejectionReason: reason,
      })
      .returning({ id: clicksTable.id });

    if (reason) {
      await tx
        .update(campaignsTable)
        .set({ status: "expired" })
        .where(eq(campaignsTable.id, valid.campaign.id));
      return { id: inserted.id, status: "rejected" as const, duplicate: false };
    }

    await tx
      .update(clicksTable)
      .set({ status: "verified" })
      .where(eq(clicksTable.id, inserted.id));
    await tx.insert(transactionsTable).values([
      {
        userId: valid.placement.ownerId,
        clickId: inserted.id,
        type: "publisher_earning",
        amount: publisherShare,
      },
      {
        userId: null,
        clickId: inserted.id,
        type: "platform_revenue",
        amount: platformShare,
      },
    ]);
    if (spent + clickPrice >= valid.campaign.monthlyFee - 0.0000001) {
      await tx
        .update(campaignsTable)
        .set({ status: "expired" })
        .where(eq(campaignsTable.id, valid.campaign.id));
    }
    return { id: inserted.id, status: "recorded" as const, duplicate: false };
  });

  res
    .status(202)
    .json(
      RecordSdkClickResponse.parse({
        eventId: String(result.id),
        status: result.status,
        duplicate: result.duplicate,
      }),
    );
});

export default router;

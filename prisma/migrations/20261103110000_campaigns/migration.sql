-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "AnnouncementTone" AS ENUM ('INFO', 'SUCCESS', 'WARNING');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminPermission" ADD VALUE 'VIEW_CAMPAIGNS';
ALTER TYPE "AdminPermission" ADD VALUE 'MANAGE_CAMPAIGNS';

-- AlterTable
ALTER TABLE "notification_settings" ADD COLUMN     "pushAnnouncements" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "push_campaigns" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "openPath" TEXT,
    "audience" JSONB NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_campaign_opens" (
    "campaignId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_campaign_opens_pkey" PRIMARY KEY ("campaignId","userId")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "tone" "AnnouncementTone" NOT NULL DEFAULT 'INFO',
    "linkUrl" TEXT,
    "linkLabel" TEXT,
    "platform" "SessionPlatform",
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "dismissible" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "featured_hosts" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "endsAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "featured_hosts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "push_campaigns_status_scheduledAt_idx" ON "push_campaigns"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "push_campaigns_createdAt_idx" ON "push_campaigns"("createdAt");

-- CreateIndex
CREATE INDEX "announcements_startsAt_idx" ON "announcements"("startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "featured_hosts_userId_key" ON "featured_hosts"("userId");

-- CreateIndex
CREATE INDEX "featured_hosts_position_idx" ON "featured_hosts"("position");

-- AddForeignKey
ALTER TABLE "push_campaigns" ADD CONSTRAINT "push_campaigns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_campaign_opens" ADD CONSTRAINT "push_campaign_opens_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "push_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_campaign_opens" ADD CONSTRAINT "push_campaign_opens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "featured_hosts" ADD CONSTRAINT "featured_hosts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "featured_hosts" ADD CONSTRAINT "featured_hosts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


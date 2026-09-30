-- CreateEnum
CREATE TYPE "ReportResolution" AS ENUM ('CONTENT_REMOVED', 'USER_SUSPENDED', 'STREAM_LOCKED', 'OTHER_ACTION');

-- CreateEnum
CREATE TYPE "AlertScope" AS ENUM ('GLOBAL', 'STREAM');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AuditCategory" AS ENUM ('AUTH', 'ACCOUNT', 'STREAM', 'CHAT', 'MODERATION', 'GUEST', 'SOCIAL', 'REPORT', 'ALERT', 'SETTINGS', 'ADMIN');

-- CreateEnum
CREATE TYPE "AuditActorRole" AS ENUM ('SUPER_ADMIN', 'PLATFORM_MODERATOR', 'HOST', 'MODERATOR', 'USER', 'SYSTEM');

-- AlterEnum
ALTER TYPE "ReportStatus" ADD VALUE 'IN_REVIEW';
ALTER TYPE "ReportStatus" ADD VALUE 'DISMISSED';

-- AlterEnum
ALTER TYPE "StreamEndReason" ADD VALUE 'LOCKED';

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "assigneeId" TEXT,
ADD COLUMN     "resolution" "ReportResolution",
ADD COLUMN     "resolutionNote" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "streams" ADD COLUMN     "lockedAt" TIMESTAMP(3),
ADD COLUMN     "lockedById" TEXT,
ADD COLUMN     "lockedReason" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "passwordChangeRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspensionReason" TEXT;

-- CreateTable
CREATE TABLE "admin_alerts" (
    "id" UUID NOT NULL,
    "scope" "AlertScope" NOT NULL,
    "streamId" TEXT,
    "message" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'INFO',
    "createdById" TEXT,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "category" "AuditCategory" NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" "AuditActorRole" NOT NULL,
    "actorLabel" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "streamId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_alerts_createdAt_idx" ON "admin_alerts"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_category_createdAt_idx" ON "audit_logs"("category", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_targetType_targetId_idx" ON "audit_logs"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "audit_logs_streamId_createdAt_idx" ON "audit_logs"("streamId", "createdAt");

-- CreateIndex
CREATE INDEX "reports_targetType_targetId_idx" ON "reports"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "streams_hostId_startedAt_idx" ON "streams"("hostId", "startedAt");

-- AddForeignKey
ALTER TABLE "streams" ADD CONSTRAINT "streams_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "streams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

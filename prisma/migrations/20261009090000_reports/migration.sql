-- What users report, and the console's Reports page (docs/features/moderation.md).
-- CreateEnum
CREATE TYPE "ReportTargetType" AS ENUM ('LIVE', 'CHAT_MESSAGE', 'USER', 'DIRECT_MESSAGE');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'SCAM', 'HARASSMENT', 'HATE', 'VIOLENCE', 'SEXUAL_CONTENT', 'CHILD_SAFETY', 'SELF_HARM', 'ILLEGAL', 'IMPERSONATION', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportCaseStatus" AS ENUM ('OPEN', 'ACTIONED', 'DISMISSED');

-- AlterEnum
ALTER TYPE "AdminPermission" ADD VALUE 'VIEW_REPORTS';
ALTER TYPE "AdminPermission" ADD VALUE 'MANAGE_REPORTS';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'REPORT_ACTIONED';
ALTER TYPE "NotificationType" ADD VALUE 'REPORT_DISMISSED';

-- CreateTable
CREATE TABLE "report_cases" (
    "id" UUID NOT NULL,
    "targetType" "ReportTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "reportedUserId" TEXT,
    "streamId" TEXT,
    "snapshot" JSONB NOT NULL,
    "status" "ReportCaseStatus" NOT NULL DEFAULT 'OPEN',
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "reportCount" INTEGER NOT NULL DEFAULT 1,
    "lastReportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "reporterId" TEXT,
    "reason" "ReportReason" NOT NULL,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_cases_status_urgent_lastReportedAt_idx" ON "report_cases"("status", "urgent", "lastReportedAt");

-- CreateIndex
CREATE INDEX "report_cases_targetType_targetId_status_idx" ON "report_cases"("targetType", "targetId", "status");

-- CreateIndex
CREATE INDEX "report_cases_reportedUserId_idx" ON "report_cases"("reportedUserId");

-- CreateIndex
CREATE INDEX "reports_reporterId_createdAt_idx" ON "reports"("reporterId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "reports_caseId_reporterId_key" ON "reports"("caseId", "reporterId");

-- AddForeignKey
ALTER TABLE "report_cases" ADD CONSTRAINT "report_cases_reportedUserId_fkey" FOREIGN KEY ("reportedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_cases" ADD CONSTRAINT "report_cases_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "report_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


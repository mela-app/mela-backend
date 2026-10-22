-- AlterTable
ALTER TABLE "video_settings" DROP COLUMN "quotaResetDay",
ADD COLUMN     "agoraReportError" TEXT,
ADD COLUMN     "agoraReportedAt" TIMESTAMP(3);

-- DropTable
DROP TABLE "video_usage_periods";

-- CreateTable
CREATE TABLE "video_usage_days" (
    "id" UUID NOT NULL,
    "provider" "VideoProviderKind" NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "countedMinutes" INTEGER NOT NULL DEFAULT 0,
    "reportedMinutes" INTEGER,
    "reportedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_usage_days_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "video_usage_days_provider_day_key" ON "video_usage_days"("provider", "day");


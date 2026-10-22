-- CreateTable
CREATE TABLE "video_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "activeProvider" "VideoProviderKind" NOT NULL,
    "agoraFreeMinutes" INTEGER NOT NULL DEFAULT 10000,
    "quotaResetDay" INTEGER NOT NULL DEFAULT 1,
    "autoSwitch" BOOLEAN NOT NULL DEFAULT false,
    "autoSwitchBelowMinutes" INTEGER NOT NULL DEFAULT 500,
    "switchBackOnReset" BOOLEAN NOT NULL DEFAULT true,
    "autoSwitchedAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_usage_periods" (
    "id" UUID NOT NULL,
    "provider" "VideoProviderKind" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "correctionMinutes" INTEGER NOT NULL DEFAULT 0,
    "correctedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_usage_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_provider_switches" (
    "id" UUID NOT NULL,
    "from" "VideoProviderKind" NOT NULL,
    "to" "VideoProviderKind" NOT NULL,
    "actorId" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_provider_switches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "video_usage_periods_provider_periodStart_key" ON "video_usage_periods"("provider", "periodStart");

-- CreateIndex
CREATE INDEX "video_provider_switches_createdAt_idx" ON "video_provider_switches"("createdAt");

-- AddForeignKey
ALTER TABLE "video_provider_switches" ADD CONSTRAINT "video_provider_switches_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AlterEnum
ALTER TYPE "AdminPermission" ADD VALUE 'VIEW_ANALYTICS';

-- AlterTable
ALTER TABLE "user_sessions" ADD COLUMN     "appBuild" INTEGER,
ADD COLUMN     "appVersion" TEXT;

-- AlterTable
ALTER TABLE "streams" ADD COLUMN     "uniqueViewers" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "viewerMinutes" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "user_active_days" (
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "platform" "SessionPlatform",

    CONSTRAINT "user_active_days_pkey" PRIMARY KEY ("userId","day")
);

-- CreateTable
CREATE TABLE "app_installs" (
    "id" UUID NOT NULL,
    "installationId" TEXT NOT NULL,
    "platform" "SessionPlatform" NOT NULL,
    "source" TEXT NOT NULL,
    "referrer" TEXT,
    "appVersion" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_installs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_active_days_day_idx" ON "user_active_days"("day");

-- CreateIndex
CREATE UNIQUE INDEX "app_installs_installationId_key" ON "app_installs"("installationId");

-- CreateIndex
CREATE INDEX "app_installs_installedAt_idx" ON "app_installs"("installedAt");

-- AddForeignKey
ALTER TABLE "user_active_days" ADD CONSTRAINT "user_active_days_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


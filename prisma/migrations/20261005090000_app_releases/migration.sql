-- App updates (docs/features/app-updates.md).
-- CreateEnum
CREATE TYPE "AppPlatform" AS ENUM ('ANDROID', 'IOS');

-- AlterEnum
ALTER TYPE "AdminPermission" ADD VALUE 'VIEW_APP_RELEASES';
ALTER TYPE "AdminPermission" ADD VALUE 'MANAGE_APP_RELEASES';

-- CreateTable
CREATE TABLE "app_releases" (
    "id" UUID NOT NULL,
    "platform" "AppPlatform" NOT NULL,
    "version" TEXT NOT NULL,
    "build" INTEGER NOT NULL,
    "notes" TEXT NOT NULL,
    "downloadUrl" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "publishedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_releases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_releases_platform_build_key" ON "app_releases"("platform", "build");

-- AddForeignKey
ALTER TABLE "app_releases" ADD CONSTRAINT "app_releases_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

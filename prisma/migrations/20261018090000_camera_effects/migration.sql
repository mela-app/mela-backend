-- CreateEnum
CREATE TYPE "CameraEffectKind" AS ENUM ('EFFECT', 'MAKEUP', 'BACKGROUND', 'BEAUTY');

-- CreateEnum
CREATE TYPE "MakeupAudience" AS ENUM ('ALL', 'FEMALE', 'MALE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminPermission" ADD VALUE 'VIEW_CAMERA_EFFECTS';
ALTER TYPE "AdminPermission" ADD VALUE 'MANAGE_CAMERA_EFFECTS';

-- CreateTable
CREATE TABLE "camera_effect_categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "camera_effect_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "camera_effects" (
    "id" UUID NOT NULL,
    "kind" "CameraEffectKind" NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" UUID,
    "audience" "MakeupAudience" NOT NULL DEFAULT 'ALL',
    "fileUrl" TEXT,
    "fileSize" INTEGER,
    "thumbnailUrl" TEXT,
    "imageUrl" TEXT,
    "controls" JSONB,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "camera_effects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "camera_effect_categories_name_key" ON "camera_effect_categories"("name");

-- CreateIndex
CREATE INDEX "camera_effects_kind_published_sortOrder_idx" ON "camera_effects"("kind", "published", "sortOrder");

-- AddForeignKey
ALTER TABLE "camera_effects" ADD CONSTRAINT "camera_effects_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "camera_effect_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "camera_effects" ADD CONSTRAINT "camera_effects_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- CreateEnum
CREATE TYPE "HostingAppealState" AS ENUM ('NONE', 'WAITING_STAFF', 'WAITING_HOST', 'KEPT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminPermission" ADD VALUE 'VIEW_HOSTING_RESTRICTIONS';
ALTER TYPE "AdminPermission" ADD VALUE 'MANAGE_HOSTING_RESTRICTIONS';

-- AlterEnum
ALTER TYPE "StreamEndReason" ADD VALUE 'HOST_RESTRICTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'HOSTING_RESTRICTED';
ALTER TYPE "NotificationType" ADD VALUE 'HOSTING_RESTORED';
ALTER TYPE "NotificationType" ADD VALUE 'HOSTING_APPEAL_ANSWERED';

-- CreateTable
CREATE TABLE "hosting_restriction_reasons" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosting_restriction_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hosting_restrictions" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "streamId" TEXT,
    "reasonId" UUID,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "note" TEXT,
    "endsAt" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),
    "liftedById" TEXT,
    "appealState" "HostingAppealState" NOT NULL DEFAULT 'NONE',
    "keptAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosting_restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hosting_restriction_messages" (
    "id" UUID NOT NULL,
    "restrictionId" UUID NOT NULL,
    "authorId" TEXT,
    "fromStaff" BOOLEAN NOT NULL,
    "text" TEXT NOT NULL,
    "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hosting_restriction_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hosting_restriction_reasons_archived_createdAt_idx" ON "hosting_restriction_reasons"("archived", "createdAt");

-- CreateIndex
CREATE INDEX "hosting_restrictions_userId_liftedAt_idx" ON "hosting_restrictions"("userId", "liftedAt");

-- CreateIndex
CREATE INDEX "hosting_restrictions_streamId_createdAt_idx" ON "hosting_restrictions"("streamId", "createdAt");

-- CreateIndex
CREATE INDEX "hosting_restrictions_appealState_updatedAt_idx" ON "hosting_restrictions"("appealState", "updatedAt");

-- CreateIndex
CREATE INDEX "hosting_restriction_messages_restrictionId_createdAt_idx" ON "hosting_restriction_messages"("restrictionId", "createdAt");

-- AddForeignKey
ALTER TABLE "hosting_restriction_reasons" ADD CONSTRAINT "hosting_restriction_reasons_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosting_restrictions" ADD CONSTRAINT "hosting_restrictions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosting_restrictions" ADD CONSTRAINT "hosting_restrictions_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "streams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosting_restrictions" ADD CONSTRAINT "hosting_restrictions_reasonId_fkey" FOREIGN KEY ("reasonId") REFERENCES "hosting_restriction_reasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosting_restrictions" ADD CONSTRAINT "hosting_restrictions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosting_restrictions" ADD CONSTRAINT "hosting_restrictions_liftedById_fkey" FOREIGN KEY ("liftedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosting_restriction_messages" ADD CONSTRAINT "hosting_restriction_messages_restrictionId_fkey" FOREIGN KEY ("restrictionId") REFERENCES "hosting_restrictions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosting_restriction_messages" ADD CONSTRAINT "hosting_restriction_messages_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


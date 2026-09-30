/*
  Warnings:

  - A unique constraint covering the columns `[pinnedMessageId]` on the table `streams` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ModeratorCapability" AS ENUM ('DELETE_MESSAGES', 'PIN_MESSAGES', 'MUTE_CHAT', 'BAN_USERS', 'MANAGE_GUEST_REQUESTS', 'REMOVE_GUESTS', 'FORCE_MUTE_GUESTS');

-- CreateEnum
CREATE TYPE "ModeratorStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "RoomBanScope" AS ENUM ('SESSION', 'HOST_PERMANENT');

-- CreateEnum
CREATE TYPE "ReportTargetType" AS ENUM ('USER', 'MESSAGE', 'STREAM');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "BannedPhraseSeverity" AS ENUM ('REJECT', 'MASK');

-- AlterTable
ALTER TABLE "streams" ADD COLUMN     "pinnedMessageId" UUID;

-- CreateTable
CREATE TABLE "moderators" (
    "id" UUID NOT NULL,
    "hostId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capabilities" "ModeratorCapability"[],
    "status" "ModeratorStatus" NOT NULL DEFAULT 'ACTIVE',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "moderators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "id" UUID NOT NULL,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_bans" (
    "id" UUID NOT NULL,
    "hostId" TEXT NOT NULL,
    "bannedUserId" TEXT NOT NULL,
    "streamId" TEXT,
    "scope" "RoomBanScope" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_bans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetType" "ReportTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banned_phrases" (
    "id" UUID NOT NULL,
    "phrase" TEXT NOT NULL,
    "severity" "BannedPhraseSeverity" NOT NULL DEFAULT 'REJECT',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "banned_phrases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "moderators_userId_idx" ON "moderators"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "moderators_hostId_userId_key" ON "moderators"("hostId", "userId");

-- CreateIndex
CREATE INDEX "blocks_blockedId_idx" ON "blocks"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "blocks_blockerId_blockedId_key" ON "blocks"("blockerId", "blockedId");

-- CreateIndex
CREATE INDEX "room_bans_hostId_bannedUserId_idx" ON "room_bans"("hostId", "bannedUserId");

-- CreateIndex
CREATE INDEX "reports_status_createdAt_idx" ON "reports"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "banned_phrases_phrase_key" ON "banned_phrases"("phrase");

-- CreateIndex
CREATE UNIQUE INDEX "streams_pinnedMessageId_key" ON "streams"("pinnedMessageId");

-- AddForeignKey
ALTER TABLE "streams" ADD CONSTRAINT "streams_pinnedMessageId_fkey" FOREIGN KEY ("pinnedMessageId") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderators" ADD CONSTRAINT "moderators_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderators" ADD CONSTRAINT "moderators_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_bans" ADD CONSTRAINT "room_bans_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_bans" ADD CONSTRAINT "room_bans_bannedUserId_fkey" FOREIGN KEY ("bannedUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_bans" ADD CONSTRAINT "room_bans_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "streams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banned_phrases" ADD CONSTRAINT "banned_phrases_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

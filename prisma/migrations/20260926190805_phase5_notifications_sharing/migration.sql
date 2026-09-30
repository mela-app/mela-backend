-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('STREAM_STARTED', 'NEW_FOLLOWER', 'STREAM_INVITE', 'MODERATOR_GRANTED', 'GUEST_INVITE');

-- AlterTable
ALTER TABLE "user_sessions" ADD COLUMN     "pushToken" TEXT;

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "recipientId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "actorId" TEXT,
    "streamId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_settings" (
    "userId" TEXT NOT NULL,
    "pushStreamStarted" BOOLEAN NOT NULL DEFAULT true,
    "pushNewFollower" BOOLEAN NOT NULL DEFAULT true,
    "pushStreamInvite" BOOLEAN NOT NULL DEFAULT true,
    "pushModeratorGranted" BOOLEAN NOT NULL DEFAULT true,
    "pushGuestInvite" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "notifications_recipientId_createdAt_idx" ON "notifications"("recipientId", "createdAt");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "streams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'FOLLOWING_JOINED_LIVE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "shareLiveJoins" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "notification_settings" ADD COLUMN     "pushFollowingJoinedLive" BOOLEAN NOT NULL DEFAULT true;


-- Who may share a profile's link (docs/features/share.md).
-- CreateEnum
CREATE TYPE "ProfileSharing" AS ENUM ('EVERYONE', 'FOLLOWERS', 'FRIENDS', 'ONLY_ME');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "profileSharing" "ProfileSharing" NOT NULL DEFAULT 'EVERYONE';

-- Who sees a profile's details (bio, counts, follow lists) - each user's choice.

-- CreateEnum
CREATE TYPE "ProfileVisibility" AS ENUM ('EVERYONE', 'FOLLOWERS', 'FRIENDS', 'ONLY_ME');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "profileVisibility" "ProfileVisibility" NOT NULL DEFAULT 'EVERYONE';

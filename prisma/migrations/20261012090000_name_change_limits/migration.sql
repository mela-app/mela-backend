-- When each name last changed: a username once in 30 days, a display name once in 7 (docs/features/users.md).
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "displayNameChangedAt" TIMESTAMP(3),
ADD COLUMN     "usernameChangedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "showActivityStatus" BOOLEAN NOT NULL DEFAULT true;

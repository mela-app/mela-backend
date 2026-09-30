-- CreateEnum
CREATE TYPE "FollowStatus" AS ENUM ('ACTIVE', 'PENDING');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "bio" TEXT;

-- CreateTable
CREATE TABLE "follows" (
    "id" TEXT NOT NULL,
    "followerId" TEXT NOT NULL,
    "followeeId" TEXT NOT NULL,
    "status" "FollowStatus" NOT NULL DEFAULT 'ACTIVE',
    "notifyOnLive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "follows_followeeId_idx" ON "follows"("followeeId");

-- CreateIndex
CREATE UNIQUE INDEX "follows_followerId_followeeId_key" ON "follows"("followerId", "followeeId");

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_followeeId_fkey" FOREIGN KEY ("followeeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/*
  Warnings:

  - A unique constraint covering the columns `[streamId,userId]` on the table `moderators` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `streamId` to the `moderators` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "moderators_hostId_userId_key";

-- AlterTable
ALTER TABLE "moderators" ADD COLUMN     "streamId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "moderators_hostId_idx" ON "moderators"("hostId");

-- CreateIndex
CREATE UNIQUE INDEX "moderators_streamId_userId_key" ON "moderators"("streamId", "userId");

-- AddForeignKey
ALTER TABLE "moderators" ADD CONSTRAINT "moderators_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "streams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

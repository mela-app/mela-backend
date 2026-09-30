-- CreateEnum
CREATE TYPE "StreamStatus" AS ENUM ('SCHEDULED', 'LIVE', 'ENDED', 'LOCKED');

-- CreateTable
CREATE TABLE "streams" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "status" "StreamStatus" NOT NULL DEFAULT 'LIVE',
    "agoraChannelName" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "streams_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "streams_agoraChannelName_key" ON "streams"("agoraChannelName");

-- CreateIndex
CREATE INDEX "streams_status_idx" ON "streams"("status");

-- AddForeignKey
ALTER TABLE "streams" ADD CONSTRAINT "streams_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

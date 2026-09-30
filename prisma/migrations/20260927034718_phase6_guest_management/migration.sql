-- CreateEnum
CREATE TYPE "GuestRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GuestRequestInitiator" AS ENUM ('VIEWER', 'HOST');

-- CreateEnum
CREATE TYPE "StreamGuestStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateTable
CREATE TABLE "guest_requests" (
    "id" UUID NOT NULL,
    "streamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "initiatedBy" "GuestRequestInitiator" NOT NULL,
    "status" "GuestRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "guest_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stream_guests" (
    "id" UUID NOT NULL,
    "streamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "StreamGuestStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "stream_guests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_requests_streamId_status_idx" ON "guest_requests"("streamId", "status");

-- CreateIndex
CREATE INDEX "guest_requests_userId_status_idx" ON "guest_requests"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stream_guests_streamId_userId_key" ON "stream_guests"("streamId", "userId");

-- AddForeignKey
ALTER TABLE "guest_requests" ADD CONSTRAINT "guest_requests_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "streams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_requests" ADD CONSTRAINT "guest_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stream_guests" ADD CONSTRAINT "stream_guests_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "streams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stream_guests" ADD CONSTRAINT "stream_guests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

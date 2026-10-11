-- Lives announced ahead, and who asked to be reminded (docs/features/streams.md).
-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'SCHEDULED_LIVE_SOON';
-- CreateTable
CREATE TABLE "scheduled_lives" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "visibility" "StreamVisibility" NOT NULL DEFAULT 'PUBLIC',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "streamId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "scheduled_lives_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "scheduled_live_reminders" (
    "scheduledLiveId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "scheduled_live_reminders_pkey" PRIMARY KEY ("scheduledLiveId","userId")
);
-- CreateIndex
CREATE UNIQUE INDEX "scheduled_lives_streamId_key" ON "scheduled_lives"("streamId");
-- CreateIndex
CREATE INDEX "scheduled_lives_hostId_startsAt_idx" ON "scheduled_lives"("hostId", "startsAt");
-- CreateIndex
CREATE INDEX "scheduled_lives_startsAt_idx" ON "scheduled_lives"("startsAt");
-- CreateIndex
CREATE INDEX "scheduled_live_reminders_userId_idx" ON "scheduled_live_reminders"("userId");
-- AddForeignKey
ALTER TABLE "scheduled_lives" ADD CONSTRAINT "scheduled_lives_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "scheduled_lives" ADD CONSTRAINT "scheduled_lives_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "streams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "scheduled_live_reminders" ADD CONSTRAINT "scheduled_live_reminders_scheduledLiveId_fkey" FOREIGN KEY ("scheduledLiveId") REFERENCES "scheduled_lives"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "scheduled_live_reminders" ADD CONSTRAINT "scheduled_live_reminders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

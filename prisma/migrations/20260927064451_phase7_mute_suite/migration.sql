-- AlterTable
ALTER TABLE "stream_guests" ADD COLUMN     "micForceMuted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "room_chat_mutes" (
    "id" UUID NOT NULL,
    "streamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mutedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_chat_mutes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personal_chat_mutes" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "mutedUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personal_chat_mutes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "room_chat_mutes_streamId_userId_key" ON "room_chat_mutes"("streamId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "personal_chat_mutes_userId_mutedUserId_key" ON "personal_chat_mutes"("userId", "mutedUserId");

-- AddForeignKey
ALTER TABLE "room_chat_mutes" ADD CONSTRAINT "room_chat_mutes_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "streams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_chat_mutes" ADD CONSTRAINT "room_chat_mutes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_chat_mutes" ADD CONSTRAINT "room_chat_mutes_mutedById_fkey" FOREIGN KEY ("mutedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_chat_mutes" ADD CONSTRAINT "personal_chat_mutes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_chat_mutes" ADD CONSTRAINT "personal_chat_mutes_mutedUserId_fkey" FOREIGN KEY ("mutedUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

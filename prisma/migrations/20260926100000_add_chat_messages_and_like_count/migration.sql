-- CreateEnum
CREATE TYPE "ChatModerationStatus" AS ENUM ('VISIBLE', 'HIDDEN', 'DELETED');

-- AlterTable
ALTER TABLE "streams" ADD COLUMN     "likeCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "streamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "moderationStatus" "ChatModerationStatus" NOT NULL DEFAULT 'VISIBLE',
    "flaggedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_messages_streamId_id_idx" ON "chat_messages"("streamId", "id");

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "streams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

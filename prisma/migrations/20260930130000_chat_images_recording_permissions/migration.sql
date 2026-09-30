-- The host's photos in live chat (docs/features/chat.md).
ALTER TABLE "chat_messages" ADD COLUMN     "imageUrl" TEXT;

-- Who the host allows to record a live (docs/features/streams.md).
CREATE TABLE "recording_permissions" (
    "id" UUID NOT NULL,
    "streamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recording_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recording_permissions_streamId_userId_key" ON "recording_permissions"("streamId", "userId");

-- AddForeignKey
ALTER TABLE "recording_permissions" ADD CONSTRAINT "recording_permissions_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "streams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_permissions" ADD CONSTRAINT "recording_permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

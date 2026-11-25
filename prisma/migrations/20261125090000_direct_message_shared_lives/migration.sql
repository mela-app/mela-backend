-- A live shared to someone lands in their private chat as a card (docs/features/share.md).
ALTER TABLE "direct_messages" ADD COLUMN "streamId" TEXT;

CREATE INDEX "direct_messages_streamId_idx" ON "direct_messages"("streamId");

ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "streams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

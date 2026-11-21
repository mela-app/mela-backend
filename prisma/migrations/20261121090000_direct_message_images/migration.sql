-- A photo sent in a private message (docs/features/messages.md); null for plain text.
ALTER TABLE "direct_messages" ADD COLUMN "imageUrl" TEXT;

-- AlterTable
ALTER TABLE "direct_messages" ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "hiddenByRecipient" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hiddenBySender" BOOLEAN NOT NULL DEFAULT false;


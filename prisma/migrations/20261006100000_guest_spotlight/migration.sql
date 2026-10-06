-- A guest on the full stage, the host's video in a tile (docs/features/guests.md).
-- AlterTable
ALTER TABLE "stream_guests" ADD COLUMN     "spotlightAt" TIMESTAMP(3);

-- CreateEnum
CREATE TYPE "StreamEndReason" AS ENUM ('HOST_ENDED', 'HOST_DISCONNECTED', 'REPLACED');

-- AlterTable
ALTER TABLE "streams" ADD COLUMN     "endedReason" "StreamEndReason",
ADD COLUMN     "peakViewerCount" INTEGER NOT NULL DEFAULT 0;

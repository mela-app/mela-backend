-- AlterEnum
ALTER TYPE "ModeratorCapability" ADD VALUE 'ARRANGE_GUESTS';

-- AlterTable
ALTER TABLE "stream_guests" ADD COLUMN     "stageSize" DOUBLE PRECISION,
ADD COLUMN     "stageX" DOUBLE PRECISION,
ADD COLUMN     "stageY" DOUBLE PRECISION;

-- Who may watch a live: everyone, followers or friends (docs/features/streams.md).
-- CreateEnum
CREATE TYPE "StreamVisibility" AS ENUM ('PUBLIC', 'FOLLOWERS', 'FRIENDS');
-- AlterTable
ALTER TABLE "streams" ADD COLUMN     "visibility" "StreamVisibility" NOT NULL DEFAULT 'PUBLIC';

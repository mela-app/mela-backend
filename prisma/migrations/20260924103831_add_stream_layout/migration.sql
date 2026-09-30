-- CreateEnum
CREATE TYPE "StreamLayout" AS ENUM ('FULL', 'FIT', 'SPLIT', 'FLOATING', 'MINIMAL');

-- AlterTable
ALTER TABLE "streams" ADD COLUMN     "layout" "StreamLayout" NOT NULL DEFAULT 'FULL';

-- AlterTable
ALTER TABLE "follows" DROP CONSTRAINT "follows_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "follows_pkey" PRIMARY KEY ("id");

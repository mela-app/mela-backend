-- AlterTable
ALTER TABLE "users" ADD COLUMN     "birthDate" DATE,
ADD COLUMN     "legalAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "legalVersion" TEXT;

-- CreateTable
CREATE TABLE "legal_acceptances" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "platform" "SessionPlatform",
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legal_acceptances_userId_acceptedAt_idx" ON "legal_acceptances"("userId", "acceptedAt");

-- AddForeignKey
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


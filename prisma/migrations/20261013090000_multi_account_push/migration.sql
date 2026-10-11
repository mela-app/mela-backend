-- AlterTable
ALTER TABLE "user_sessions" ADD COLUMN     "installationId" TEXT;

-- CreateIndex
CREATE INDEX "user_sessions_pushToken_idx" ON "user_sessions"("pushToken");


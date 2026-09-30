-- CreateEnum
CREATE TYPE "SessionPlatform" AS ENUM ('ANDROID', 'IOS', 'WEB', 'UNKNOWN');

-- AlterTable
ALTER TABLE "users" DROP COLUMN "hashedRefreshToken";

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "SessionPlatform" NOT NULL DEFAULT 'UNKNOWN',
    "refreshTokenHash" TEXT NOT NULL,
    "previousRefreshTokenHash" TEXT,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_sessions_userId_idx" ON "user_sessions"("userId");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


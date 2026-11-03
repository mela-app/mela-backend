-- CreateTable
CREATE TABLE "user_notes" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "authorId" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_notes_userId_createdAt_idx" ON "user_notes"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


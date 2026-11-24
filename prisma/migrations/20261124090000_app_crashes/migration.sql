-- What went wrong on phones (docs/features/app-crashes.md).
CREATE TYPE "AppCrashKind" AS ENUM ('DART_ERROR', 'JAVA_CRASH', 'NATIVE_CRASH', 'ANR', 'LOW_MEMORY', 'KILLED', 'OTHER');

CREATE TABLE "app_crashes" (
    "id" UUID NOT NULL,
    "userId" TEXT,
    "kind" "AppCrashKind" NOT NULL,
    "fatal" BOOLEAN NOT NULL,
    "signature" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "breadcrumbs" TEXT[],
    "platform" TEXT,
    "appVersion" TEXT,
    "appBuild" INTEGER,
    "deviceModel" TEXT,
    "osVersion" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_crashes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "app_crashes_signature_occurredAt_idx" ON "app_crashes"("signature", "occurredAt");
CREATE INDEX "app_crashes_occurredAt_idx" ON "app_crashes"("occurredAt");

ALTER TABLE "app_crashes" ADD CONSTRAINT "app_crashes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Releases are compared by version; the build and a link of their own are
-- kept only on releases published before (docs/features/app-updates.md).
ALTER TABLE "app_releases" ALTER COLUMN "build" DROP NOT NULL,
ALTER COLUMN "downloadUrl" DROP NOT NULL;

-- Reporting is removed entirely: the user-facing report button, the admin
-- reports queue, and the permissions that guarded it.

-- Moderators lose the report permissions (the only values going away), and
-- the audit entries about reports go with the reports themselves - both
-- would otherwise fail the enum casts below.
UPDATE "users"
SET "adminPermissions" = array_remove(array_remove("adminPermissions", 'VIEW_REPORTS'), 'MANAGE_REPORTS')
WHERE "adminPermissions" && ARRAY['VIEW_REPORTS', 'MANAGE_REPORTS']::"AdminPermission"[];

DELETE FROM "audit_logs" WHERE "category" = 'REPORT';

-- AlterEnum
BEGIN;
CREATE TYPE "AdminPermission_new" AS ENUM ('VIEW_LIVES', 'MANAGE_LIVES', 'VIEW_USERS', 'MANAGE_USERS', 'VIEW_ALERTS', 'SEND_ALERTS', 'SEND_GLOBAL_ALERTS', 'VIEW_PHRASES', 'MANAGE_PHRASES', 'VIEW_AUDIT_LOG');
ALTER TABLE "public"."users" ALTER COLUMN "adminPermissions" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "adminPermissions" TYPE "AdminPermission_new"[] USING ("adminPermissions"::text::"AdminPermission_new"[]);
ALTER TYPE "AdminPermission" RENAME TO "AdminPermission_old";
ALTER TYPE "AdminPermission_new" RENAME TO "AdminPermission";
DROP TYPE "public"."AdminPermission_old";
ALTER TABLE "users" ALTER COLUMN "adminPermissions" SET DEFAULT ARRAY[]::"AdminPermission"[];
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "AuditCategory_new" AS ENUM ('AUTH', 'ACCOUNT', 'STREAM', 'CHAT', 'MODERATION', 'GUEST', 'SOCIAL', 'ALERT', 'SETTINGS', 'ADMIN');
ALTER TABLE "audit_logs" ALTER COLUMN "category" TYPE "AuditCategory_new" USING ("category"::text::"AuditCategory_new");
ALTER TYPE "AuditCategory" RENAME TO "AuditCategory_old";
ALTER TYPE "AuditCategory_new" RENAME TO "AuditCategory";
DROP TYPE "public"."AuditCategory_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "reports" DROP CONSTRAINT "reports_assigneeId_fkey";

-- DropForeignKey
ALTER TABLE "reports" DROP CONSTRAINT "reports_reporterId_fkey";

-- DropForeignKey
ALTER TABLE "reports" DROP CONSTRAINT "reports_resolvedById_fkey";

-- DropTable
DROP TABLE "reports";

-- DropEnum
DROP TYPE "ReportResolution";

-- DropEnum
DROP TYPE "ReportStatus";

-- DropEnum
DROP TYPE "ReportTargetType";

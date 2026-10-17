-- Camera effects (DeepAR) are taken out of Mela: their tables, and the two
-- staff permissions - removed from any staff account that had them first,
-- or the permission type couldn't be narrowed.

-- AlterEnum
BEGIN;
UPDATE "users"
SET "adminPermissions" = array_remove(array_remove("adminPermissions", 'VIEW_CAMERA_EFFECTS'), 'MANAGE_CAMERA_EFFECTS')
WHERE 'VIEW_CAMERA_EFFECTS' = ANY("adminPermissions") OR 'MANAGE_CAMERA_EFFECTS' = ANY("adminPermissions");
CREATE TYPE "AdminPermission_new" AS ENUM ('VIEW_LIVES', 'MANAGE_LIVES', 'VIEW_USERS', 'MANAGE_USERS', 'VIEW_ALERTS', 'SEND_ALERTS', 'SEND_GLOBAL_ALERTS', 'VIEW_PHRASES', 'MANAGE_PHRASES', 'VIEW_AUDIT_LOG', 'VIEW_PRIVATE_MESSAGES', 'VIEW_APP_RELEASES', 'MANAGE_APP_RELEASES', 'VIEW_REPORTS', 'MANAGE_REPORTS', 'VIEW_HOSTING_RESTRICTIONS', 'MANAGE_HOSTING_RESTRICTIONS');
ALTER TABLE "users" ALTER COLUMN "adminPermissions" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "adminPermissions" TYPE "AdminPermission_new"[] USING ("adminPermissions"::text::"AdminPermission_new"[]);
ALTER TYPE "AdminPermission" RENAME TO "AdminPermission_old";
ALTER TYPE "AdminPermission_new" RENAME TO "AdminPermission";
DROP TYPE "AdminPermission_old";
ALTER TABLE "users" ALTER COLUMN "adminPermissions" SET DEFAULT ARRAY[]::"AdminPermission"[];
COMMIT;

-- DropForeignKey
ALTER TABLE "camera_effects" DROP CONSTRAINT "camera_effects_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "camera_effects" DROP CONSTRAINT "camera_effects_createdById_fkey";

-- DropTable
DROP TABLE "camera_effect_categories";

-- DropTable
DROP TABLE "camera_effects";

-- DropEnum
DROP TYPE "CameraEffectKind";

-- DropEnum
DROP TYPE "MakeupAudience";


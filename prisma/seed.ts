import { AuditActorRole, AuditCategory, PlatformRole, PrismaClient, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { adminPasswordProblem } from '../src/admin/password-policy';

/**
 * Ensures the default super admin exists (docs/features/admin.md). Safe to
 * re-run: an existing account is never given a new password - it is only
 * promoted to super admin if it isn't one already.
 *
 *   SEED_ADMIN_EMAIL     the account; without it the seed does nothing
 *   SEED_ADMIN_PASSWORD  required for a new account; replaced at first sign-in
 *   SEED_ADMIN_NAME      default "Administrator"
 */
const prisma = new PrismaClient();

const SEED_LABEL = 'System (seed)';

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) {
    console.log('SEED_ADMIN_EMAIL is not set - no super admin seeded.');
    return;
  }
  const displayName = process.env.SEED_ADMIN_NAME?.trim() || 'Administrator';

  const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  if (existing) {
    if (existing.status !== UserStatus.ACTIVE) {
      console.warn(`Warning: ${email} is suspended - reinstate it before signing in.`);
    }
    if (existing.platformRole === PlatformRole.SUPER_ADMIN) {
      console.log(`${email} is already a super admin - left unchanged.`);
      return;
    }
    await prisma.user.update({ where: { id: existing.id }, data: { platformRole: PlatformRole.SUPER_ADMIN } });
    await prisma.auditLog.create({
      data: {
        category: AuditCategory.ADMIN,
        action: 'user.role_changed',
        actorRole: AuditActorRole.SYSTEM,
        actorLabel: SEED_LABEL,
        targetType: 'USER',
        targetId: existing.id,
        targetLabel: `@${existing.username}`,
        metadata: { from: existing.platformRole, to: PlatformRole.SUPER_ADMIN },
      },
    });
    console.log(`Promoted ${email} to super admin. Its password was not changed.`);
    return;
  }

  const password = process.env.SEED_ADMIN_PASSWORD ?? '';
  const problem = adminPasswordProblem(password, email);
  if (problem) {
    throw new Error(`SEED_ADMIN_PASSWORD is not usable: ${problem}.`);
  }

  const username = await freeUsername('admin');
  const admin = await prisma.user.create({
    data: {
      email,
      username,
      displayName,
      passwordHash: await argon2.hash(password),
      platformRole: PlatformRole.SUPER_ADMIN,
      passwordChangeRequired: true,
    },
  });
  await prisma.auditLog.create({
    data: {
      category: AuditCategory.ADMIN,
      action: 'admin.seeded',
      actorRole: AuditActorRole.SYSTEM,
      actorLabel: SEED_LABEL,
      targetType: 'USER',
      targetId: admin.id,
      targetLabel: `@${admin.username}`,
      metadata: { role: PlatformRole.SUPER_ADMIN },
    },
  });
  console.log(
    `Created super admin ${email} (@${username}). Sign in to the admin console with SEED_ADMIN_PASSWORD; ` +
      'you will be asked to choose a new password straight away.',
  );
}

async function freeUsername(base: string): Promise<string> {
  for (let suffix = 0; ; suffix++) {
    const candidate = suffix === 0 ? base : `${base}_${suffix + 1}`;
    const taken = await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

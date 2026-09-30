import { PlatformRole } from '@prisma/client';

// Minimal shape every caller needs - keeps this service decoupled from the
// full User model (and from Prisma models that don't exist yet, like
// streams/moderators - see docs/features/permissions.md).
export interface PermissionsUser {
  id: string;
  platformRole: PlatformRole;
}

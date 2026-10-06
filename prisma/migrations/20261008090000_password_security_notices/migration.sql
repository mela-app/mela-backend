-- Security notices about the recipient's own account (docs/features/notifications.md).
ALTER TYPE "NotificationType" ADD VALUE 'PASSWORD_ADDED';
ALTER TYPE "NotificationType" ADD VALUE 'PASSWORD_CHANGED';

-- Push for direct messages from friends, on unless turned off (docs/features/notifications.md).
ALTER TABLE "notification_settings" ADD COLUMN     "pushDirectMessages" BOOLEAN NOT NULL DEFAULT true;

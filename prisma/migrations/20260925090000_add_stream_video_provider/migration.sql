-- CreateEnum
CREATE TYPE "VideoProviderKind" AS ENUM ('AGORA', 'LIVEKIT');

-- AlterTable: every existing stream went live on Agora.
ALTER TABLE "streams" ADD COLUMN     "videoProvider" "VideoProviderKind" NOT NULL DEFAULT 'AGORA';

-- Renamed in place (not drop + add) so existing channel names survive.
ALTER TABLE "streams" RENAME COLUMN "agoraChannelName" TO "channelName";
ALTER INDEX "streams_agoraChannelName_key" RENAME TO "streams_channelName_key";

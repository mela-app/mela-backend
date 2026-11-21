import { IsBoolean, IsUUID } from 'class-validator';

// The app went to the background (away) or came back: online is "open in front".
export class PresenceStateDto {
  @IsBoolean()
  away!: boolean;
}

// Whose online / last seen to follow - the conversation open on this device.
export class PresenceWatchDto {
  @IsUUID()
  userId!: string;
}

// Typing to [userId] in private messages, or stopped.
export class DirectTypingDto {
  @IsUUID()
  userId!: string;

  @IsBoolean()
  typing!: boolean;
}

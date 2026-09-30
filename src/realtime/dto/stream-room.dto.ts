import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class StreamRoomDto {
  @IsUUID()
  streamId!: string;
}

export class HostAwayDto extends StreamRoomDto {
  @IsBoolean()
  away!: boolean;
}

export class HostPauseDto extends StreamRoomDto {
  @IsBoolean()
  paused!: boolean;
}

// A reconnecting host app says whether it's still in the background, and whether its live is paused.
export class HostJoinDto extends StreamRoomDto {
  @IsOptional()
  @IsBoolean()
  away?: boolean;

  @IsOptional()
  @IsBoolean()
  paused?: boolean;
}

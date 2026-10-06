import { Type } from 'class-transformer';
import { IsDefined, IsUUID, ValidateNested } from 'class-validator';
import { GuestPlacementDto } from '../../streams/dto/guest-placement.dto';
import { StreamRoomDto } from './stream-room.dto';

/** Where a guest's tile is while it's being dragged - shown to the room, never stored. */
export class GuestMovingDto extends StreamRoomDto {
  @IsUUID()
  userId!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => GuestPlacementDto)
  placement!: GuestPlacementDto;
}

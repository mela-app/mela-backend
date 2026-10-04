import { IsNumber, Max, Min } from 'class-validator';

// A guest tile's width, as a share of the stage's guest area (docs/features/guests.md).
export const GUEST_TILE_MIN_SIZE = 0.15;
export const GUEST_TILE_MAX_SIZE = 0.6;

/** Where a guest's tile goes: 0 is flush left/top, 1 flush right/bottom, within the room the tile leaves. */
export class GuestPlacementDto {
  @IsNumber()
  @Min(0)
  @Max(1)
  x!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  y!: number;

  @IsNumber()
  @Min(GUEST_TILE_MIN_SIZE)
  @Max(GUEST_TILE_MAX_SIZE)
  size!: number;
}

import { IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Writes, edits or moves the board: [text] left out moves the one there. */
export class SetBoardDto {
  // Cleaned and checked by LiveBoardService (lines, length, phrases, links).
  @IsOptional()
  @IsString()
  @MaxLength(500)
  text?: string;

  // Where it sits on the stage, 0 to 1 across and down.
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  x?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  y?: number;
}

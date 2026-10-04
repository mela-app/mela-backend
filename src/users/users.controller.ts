import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { SocialService } from '../social/social.service';
import { CursorQueryDto } from '../social/dto/cursor-query.dto';
import { FollowNotifyDto } from '../social/dto/follow-notify.dto';
import { SearchUsersQueryDto } from '../social/dto/search-users.dto';
import { AvatarUploadUrlDto } from './dto/avatar-upload-url.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly socialService: SocialService,
  ) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getOwnProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.findPublicProfile(user.id, user.id);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  updateOwnProfile(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateOwnProfile(user.id, dto);
  }

  @Post('me/avatar/upload-url')
  @UseGuards(JwtAuthGuard)
  createAvatarUploadUrl(@CurrentUser() user: AuthenticatedUser, @Body() dto: AvatarUploadUrlDto) {
    return this.usersService.createAvatarUploadUrl(user.id, dto.contentType);
  }

  @Get('me/friends')
  @UseGuards(JwtAuthGuard)
  listFriends(@CurrentUser() user: AuthenticatedUser, @Query() query: CursorQueryDto) {
    return this.socialService.listFriends(user.id, query.cursor, query.limit);
  }

  // Whose chat messages the app hides: muted in chat or blocked (plan §6.7).
  @Get('me/chat-filter')
  @UseGuards(JwtAuthGuard)
  chatFilter(@CurrentUser() user: AuthenticatedUser) {
    return this.socialService.chatFilter(user.id);
  }

  // Declared before ':id' so a search request isn't parsed as a user id.
  @Get('search')
  @UseGuards(OptionalJwtAuthGuard)
  search(@CurrentUser() user: AuthenticatedUser | undefined, @Query() query: SearchUsersQueryDto) {
    return this.socialService.search(query.q, user?.id, query.cursor, query.limit);
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  getPublicProfile(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.usersService.findPublicProfile(id, user?.id);
  }

  @Post(':id/follow')
  @UseGuards(JwtAuthGuard)
  follow(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.socialService.follow(user.id, id);
  }

  @Delete(':id/follow')
  @UseGuards(JwtAuthGuard)
  unfollow(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.socialService.unfollow(user.id, id);
  }

  @Patch(':id/follow')
  @UseGuards(JwtAuthGuard)
  updateFollow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FollowNotifyDto,
  ) {
    return this.socialService.setNotifyOnLive(user.id, id, dto.notifyOnLive);
  }

  @Post(':id/block')
  @UseGuards(JwtAuthGuard)
  block(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.socialService.block(user.id, id);
  }

  @Delete(':id/block')
  @UseGuards(JwtAuthGuard)
  unblock(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.socialService.unblock(user.id, id);
  }

  @Post(':id/chat-mute')
  @UseGuards(JwtAuthGuard)
  muteInChat(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.socialService.muteInChat(user.id, id);
  }

  @Delete(':id/chat-mute')
  @UseGuards(JwtAuthGuard)
  unmuteInChat(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.socialService.unmuteInChat(user.id, id);
  }

  @Get(':id/followers')
  @UseGuards(OptionalJwtAuthGuard)
  followers(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CursorQueryDto,
  ) {
    return this.socialService.listFollowers(id, user?.id, query.cursor, query.limit);
  }

  @Get(':id/following')
  @UseGuards(OptionalJwtAuthGuard)
  following(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CursorQueryDto,
  ) {
    return this.socialService.listFollowing(id, user?.id, query.cursor, query.limit);
  }
}

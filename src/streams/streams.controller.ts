import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { BanUserDto } from './dto/ban-user.dto';
import { CreateStreamDto } from './dto/create-stream.dto';
import { GrantModeratorDto } from './dto/grant-moderator.dto';
import { InviteGuestDto } from './dto/invite-guest.dto';
import { ListStreamsQueryDto } from './dto/list-streams.dto';
import { MentionSuggestionsQueryDto } from './dto/mention-suggestions-query.dto';
import { MuteChatDto } from './dto/mute-chat.dto';
import { UpdateModeratorCapabilitiesDto } from './dto/update-moderator-capabilities.dto';
import { UpdateStreamLayoutDto } from './dto/update-stream-layout.dto';
import { ViewersQueryDto } from './dto/viewers-query.dto';
import { StreamsService } from './streams.service';

@Controller('streams')
export class StreamsController {
  constructor(private readonly streamsService: StreamsService) {}

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  list(@CurrentUser() user: AuthenticatedUser | undefined, @Query() query: ListStreamsQueryDto) {
    return this.streamsService.listLive(query, user?.id);
  }

  // Lets the go-live screen start a local camera preview - no stream/token
  // created yet - before the host actually taps "Start broadcasting".
  @Get('config')
  @UseGuards(JwtAuthGuard)
  getConfig() {
    return this.streamsService.getVideoConfig();
  }

  // Declared after 'config' so that path isn't taken for an id.
  @Get(':id')
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.streamsService.getPublic(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  goLive(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateStreamDto) {
    return this.streamsService.goLive(user.id, dto);
  }

  @Post(':id/join')
  @UseGuards(JwtAuthGuard)
  join(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.streamsService.join(id, user.id);
  }

  // The share page's player: anyone may watch; everything else takes an account.
  @Post(':id/watch')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  watch(@CurrentUser() user: AuthenticatedUser | undefined, @Param('id', ParseUUIDPipe) id: string) {
    return this.streamsService.watch(id, user?.id);
  }

  @Post(':id/end')
  @UseGuards(JwtAuthGuard)
  end(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.streamsService.end(id, user.id);
  }

  @Get(':id/summary')
  @UseGuards(JwtAuthGuard)
  summary(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.streamsService.summary(id, user.id);
  }

  @Patch(':id/layout')
  @UseGuards(JwtAuthGuard)
  updateLayout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateStreamLayoutDto,
  ) {
    return this.streamsService.updateLayout(id, user.id, dto.layout);
  }

  @Get(':id/viewers')
  @UseGuards(JwtAuthGuard)
  listViewers(@Param('id', ParseUUIDPipe) id: string, @Query() query: ViewersQueryDto) {
    return this.streamsService.listViewers(id, query.cursor, query.limit);
  }

  @Get(':id/mention-suggestions')
  @UseGuards(JwtAuthGuard)
  mentionSuggestions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: MentionSuggestionsQueryDto,
  ) {
    return this.streamsService.mentionSuggestions(id, user.id, query.q, query.limit);
  }

  @Post(':id/bans/:userId')
  @UseGuards(JwtAuthGuard)
  ban(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: BanUserDto,
  ) {
    return this.streamsService.banFromRoom(id, user.id, userId, dto.scope);
  }

  @Delete(':id/bans/:userId')
  @UseGuards(JwtAuthGuard)
  unban(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.streamsService.unbanFromRoom(id, user.id, userId);
  }

  @Get(':id/chat/mutes')
  @UseGuards(JwtAuthGuard)
  listChatMutes(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.streamsService.listChatMutes(id, user.id);
  }

  @Post(':id/chat/mutes/:userId')
  @UseGuards(JwtAuthGuard)
  muteChat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: MuteChatDto,
  ) {
    return this.streamsService.muteChat(id, user.id, userId, dto.durationSeconds);
  }

  @Delete(':id/chat/mutes/:userId')
  @UseGuards(JwtAuthGuard)
  unmuteChat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.streamsService.unmuteChat(id, user.id, userId);
  }

  @Get(':id/recording-permissions')
  @UseGuards(JwtAuthGuard)
  listRecordingPermissions(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.streamsService.listRecordingPermissions(id, user.id);
  }

  @Post(':id/recording-permissions/:userId')
  @UseGuards(JwtAuthGuard)
  allowRecording(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.streamsService.allowRecording(id, user.id, userId);
  }

  @Delete(':id/recording-permissions/:userId')
  @UseGuards(JwtAuthGuard)
  disallowRecording(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.streamsService.disallowRecording(id, user.id, userId);
  }

  @Get(':id/moderators')
  @UseGuards(JwtAuthGuard)
  listModerators(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.streamsService.listModerators(id, user.id);
  }

  @Post(':id/moderators')
  @UseGuards(JwtAuthGuard)
  grantModerator(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GrantModeratorDto,
  ) {
    return this.streamsService.grantModerator(id, user.id, dto.userId, dto.capabilities);
  }

  @Patch(':id/moderators/:userId')
  @UseGuards(JwtAuthGuard)
  updateModerator(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateModeratorCapabilitiesDto,
  ) {
    return this.streamsService.updateModerator(id, user.id, userId, dto.capabilities);
  }

  @Delete(':id/moderators/:userId')
  @UseGuards(JwtAuthGuard)
  revokeModerator(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.streamsService.revokeModerator(id, user.id, userId);
  }

  @Get(':id/guests')
  @UseGuards(JwtAuthGuard)
  listActiveGuests(@Param('id', ParseUUIDPipe) id: string) {
    return this.streamsService.listActiveGuests(id);
  }

  @Post(':id/guests/:userId/remove')
  @UseGuards(JwtAuthGuard)
  removeGuest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.streamsService.removeGuest(id, user.id, userId);
  }

  @Post(':id/guests/leave')
  @UseGuards(JwtAuthGuard)
  leaveGuestSeat(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.streamsService.leaveGuestSeat(id, user.id);
  }

  @Post(':id/guests/:userId/mute-audio')
  @UseGuards(JwtAuthGuard)
  forceMuteGuestMic(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.streamsService.setGuestMicForceMuted(id, user.id, userId, true);
  }

  @Delete(':id/guests/:userId/mute-audio')
  @UseGuards(JwtAuthGuard)
  allowGuestMic(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.streamsService.setGuestMicForceMuted(id, user.id, userId, false);
  }

  @Get(':id/guest-requests')
  @UseGuards(JwtAuthGuard)
  listGuestRequests(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.streamsService.listGuestRequests(id, user.id);
  }

  @Post(':id/guest-requests')
  @UseGuards(JwtAuthGuard)
  requestToJoinAsGuest(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.streamsService.requestToJoinAsGuest(id, user.id);
  }

  @Post(':id/guest-invites')
  @UseGuards(JwtAuthGuard)
  inviteGuest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteGuestDto,
  ) {
    return this.streamsService.inviteGuest(id, user.id, dto.userId);
  }

  @Delete(':id/guest-requests/:requestId')
  @UseGuards(JwtAuthGuard)
  cancelGuestRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.streamsService.cancelGuestRequest(id, requestId, user.id);
  }

  @Post(':id/guest-requests/:requestId/accept')
  @UseGuards(JwtAuthGuard)
  acceptGuestRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.streamsService.acceptGuestRequest(id, requestId, user.id);
  }

  @Post(':id/guest-requests/:requestId/reject')
  @UseGuards(JwtAuthGuard)
  rejectGuestRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.streamsService.rejectGuestRequest(id, requestId, user.id);
  }
}

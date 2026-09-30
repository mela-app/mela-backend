import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { FcmPushProvider } from './fcm-push.provider';
import { NoopPushProvider } from './noop-push.provider';
import { PUSH_PROVIDER } from './push-provider.interface';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PUSH_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const kind = (config.get<string>('PUSH_PROVIDER') ?? 'noop').trim().toLowerCase();
        if (kind === 'fcm') return new FcmPushProvider(config);
        return new NoopPushProvider();
      },
    },
  ],
  exports: [PUSH_PROVIDER],
})
export class PushProviderModule {}

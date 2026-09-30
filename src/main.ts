import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RealtimeIoAdapter } from './realtime/realtime-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Validated at boot (env.validation.ts): no built-in port or origins.
  const config = app.get(ConfigService);
  const corsOrigin = config
    .getOrThrow<string>('CORS_ORIGIN')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  // Behind a reverse proxy, the audit trail should record the client's IP, not the proxy's.
  const trustProxy = config.get<string>('TRUST_PROXY')?.trim();
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

  app.use(helmet());
  // Plan §7: smaller responses on slow mobile networks.
  app.use(compression());
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' }); // -> /v1/*
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  // Credentials: the admin console keeps its refresh token in an httpOnly cookie.
  app.enableCors({ origin: corsOrigin, credentials: true });
  app.useWebSocketAdapter(new RealtimeIoAdapter(app, corsOrigin));
  // Lets a deploy's SIGTERM close sockets, Redis and Prisma cleanly.
  app.enableShutdownHooks();

  const port = config.getOrThrow<string>('PORT');
  await app.listen(port);
}

bootstrap();

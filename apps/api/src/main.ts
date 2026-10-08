import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  try {
    const harnessRunId = process.env.FULFILLMENT_HARNESS_RUN_ID;
    const testHarnessStartup = process.env.NODE_ENV === 'test' && harnessRunId !== undefined;
    if (
      process.env.NODE_ENV === 'test' &&
      harnessRunId !== undefined &&
      !/^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(harnessRunId)
    ) {
      throw new Error('Fulfillment harness run ID is invalid');
    }

    const app = await NestFactory.create(AppModule, { rawBody: true });

    const expressApp = app.getHttpAdapter().getInstance();
    expressApp.set('trust proxy', 'loopback, linklocal, 127.0.0.1, ::1');

    // 1. CORS Configuration
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const allowedOrigins = [frontendUrl, 'http://localhost:3000', 'http://127.0.0.1:3000'];
    app.enableCors({
      origin: (origin, callback) => {
        if (
          !origin ||
          allowedOrigins.includes(origin) ||
          /^http:\/\/(localhost|127\.0\.0\.1):3000$/.test(origin)
        ) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: true,
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    });

    // 2. Global Validation Pipe
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    // 3. Set Global URL Path Prefix
    app.setGlobalPrefix('api', {
      exclude: ['health', 'health/(.*)', 'api/health', 'api/health/(.*)'],
    });

    // Enable shutdown hooks to run OnModuleDestroy
    app.enableShutdownHooks();

    // 4. Register Global HTTP Exception Filter
    app.useGlobalFilters(new HttpExceptionFilter());

    const port = process.env.PORT || 3001;
    if (testHarnessStartup) {
      await app.listen(port, '127.0.0.1');
      const address: unknown = app.getHttpServer().address();
      if (
        typeof address !== 'object' ||
        address === null ||
        !('address' in address) ||
        typeof address.address !== 'string' ||
        !('port' in address) ||
        typeof address.port !== 'number' ||
        address.address !== '127.0.0.1' ||
        address.port !== Number(port)
      ) {
        throw new Error('Fulfillment harness API did not bind to its allocated loopback address');
      }
      logger.log('Fulfillment harness API listening at http://' + address.address + ':' + address.port);
    } else {
      await app.listen(port);
    }
    logger.log(`API application running on: http://localhost:${port}/api`);
  } catch (error) {
    logger.error('Error bootstrapping NestJS application:', error);
    process.exit(1);
  }
}

bootstrap();

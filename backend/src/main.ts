import 'dotenv/config';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // One JSON object per line in production (the Docker image sets NODE_ENV),
    // readable text in development.
    logger: new ConsoleLogger({ json: process.env.NODE_ENV === 'production' }),
  });
  setupApp(app);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();

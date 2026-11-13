import { INestApplication, ValidationPipe } from '@nestjs/common';

// Shared by main.ts and e2e tests so both run with the same HTTP configuration.
export function setupApp(app: INestApplication): void {
  // All API routes live under /api; the Next.js frontend proxies /api/* here.
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}

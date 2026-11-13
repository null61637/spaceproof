import { Module } from '@nestjs/common';
import { AnchoringModule } from './anchoring/anchoring.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CertificatesModule } from './certificates/certificates.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, CertificatesModule, AnchoringModule],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}

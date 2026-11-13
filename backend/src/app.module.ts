import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CertificatesModule } from './certificates/certificates.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, CertificatesModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

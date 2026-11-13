import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  const prisma = { $queryRaw: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();
    controller = moduleRef.get(HealthController);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('live never touches the database', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('ready runs SELECT 1', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      database: 'ok',
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('ready answers 503 when the database fails', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
    await expect(controller.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('ready answers 503 instead of hanging when the database does not answer', async () => {
    jest.useFakeTimers();
    prisma.$queryRaw.mockReturnValue(new Promise(() => undefined));
    const result = controller.ready();
    jest.advanceTimersByTime(2000);
    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

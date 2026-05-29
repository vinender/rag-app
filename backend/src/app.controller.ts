import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  root() {
    return { service: 'rag-app backend', status: 'ok' };
  }

  @Get('health')
  health() {
    return { status: 'ok', uptime: process.uptime() };
  }
}

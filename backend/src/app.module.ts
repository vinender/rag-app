import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';

import { DocumentsModule } from './documents/documents.module';
import { AppController } from './app.controller';

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): TypeOrmModuleOptions => {
        const url = config.get<string>('DATABASE_URL');
        const useSsl = config.get('DATABASE_SSL') === 'true' || !!url;

        const base = {
          type: 'postgres' as const,
          autoLoadEntities: true,
          // Schema is managed manually in DocumentsService (pgvector types).
          synchronize: false,
          ssl: useSsl ? { rejectUnauthorized: false } : false,
        };

        if (url) {
          return { ...base, url };
        }

        return {
          ...base,
          host: config.get<string>('DATABASE_HOST', 'localhost'),
          port: Number(config.get('DATABASE_PORT', 5432)),
          username: config.get<string>('DATABASE_USER', 'postgres'),
          password: config.get<string>('DATABASE_PASSWORD', 'postgres'),
          database: config.get<string>('DATABASE_NAME', 'rag_db'),
        };
      },
    }),

    DocumentsModule,
  ],
})
export class AppModule {}

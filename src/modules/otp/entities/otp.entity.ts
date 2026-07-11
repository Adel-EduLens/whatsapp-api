import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { dateColumnType } from '../../../common/utils/column-types';

export enum OtpStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

@Entity('otps')
@Index(['phone', 'status'])
@Index(['sessionId', 'status'])
export class Otp {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 30 })
  phone: string;

  @Column({ type: 'varchar', length: 10 })
  code: string;

  @Column({ type: 'uuid' })
  sessionId: string;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  callbackUrl: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  callbackSecret: string | null;

  @Column({ type: 'varchar', length: 20, default: OtpStatus.PENDING })
  status: OtpStatus;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  expiresAt: Date;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  verifiedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}

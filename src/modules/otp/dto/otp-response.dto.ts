import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class OtpResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  id: string;

  @ApiProperty({ example: '+628123456789' })
  phone: string;

  @ApiProperty({ enum: ['pending', 'verified', 'expired', 'cancelled'], example: 'pending' })
  status: string;

  @ApiProperty({ example: '2026-07-11T12:02:00.000Z' })
  expiresAt: string;

  @ApiPropertyOptional({ example: 'https://wa.me/628123456789?text=4821' })
  whatsappLink?: string;

  @ApiPropertyOptional({ example: '2026-07-11T12:01:30.000Z' })
  verifiedAt?: string;

  @ApiProperty({ example: '2026-07-11T12:00:00.000Z' })
  createdAt: string;
}

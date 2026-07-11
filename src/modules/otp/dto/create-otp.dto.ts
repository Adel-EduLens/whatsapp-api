import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  Matches,
  IsOptional,
  IsUrl,
  IsInt,
  Min,
  Max,
  MinLength,
  MaxLength,
} from 'class-validator';

export class CreateOtpDto {
  @ApiProperty({
    description: 'Phone number to verify (E.164 format)',
    example: '+628123456789',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+[1-9]\d{6,14}$/, { message: 'phone must be in E.164 format (e.g. +628123456789)' })
  phone: string;

  @ApiProperty({
    description: 'OTP code the user must send (4-6 digits)',
    example: '4821',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4,6}$/, { message: 'code must be 4-6 digits' })
  code: string;

  @ApiProperty({
    description: 'Session name to receive the OTP message on',
    example: 'main',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  sessionId: string;

  @ApiPropertyOptional({
    description: 'URL to POST verification result to',
    example: 'https://website.com/api/verify',
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  callbackUrl?: string;

  @ApiPropertyOptional({
    description: 'HMAC secret for signing the callback payload',
    example: 'my-secret-key',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  callbackSecret?: string;

  @ApiPropertyOptional({
    description: 'OTP expiry in seconds (default: 120)',
    example: 120,
    default: 120,
  })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(600)
  expiresIn?: number;
}

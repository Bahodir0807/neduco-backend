import {
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class UpdatePaymentDto {
  @IsOptional()
  @IsNumber({}, { message: 'amount must be a number' })
  @Min(0, { message: 'amount cannot be less than 0' })
  amount?: number;

  @IsOptional()
  @IsString({ message: 'comment must be a string' })
  comment?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'dueDate must be a valid ISO8601 date string' })
  dueDate?: string;
}
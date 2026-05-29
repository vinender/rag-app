import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class AskDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  question: string;
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payments.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { Roles } from '../roles/roles.decorator';
import { Role } from '../roles/roles.enum';
import { PaymentsListQueryDto } from './dto/payments-list-query.dto';
import { AuditLogService } from '../common/audit/audit-log.service';
import { IdParamDto } from '../common/dto/id-param.dto';
import { StudentIdParamDto } from '../common/dto/student-id-param.dto';
import { AuthenticatedUser } from '../common/types/authenticated-user.type';
import { PaymentReportsSummaryQueryDto } from './dto/payment-reports-summary-query.dto';
import { PaymentDebtorsQueryDto } from './dto/payment-debtors-query.dto';

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Post()
  @Roles(Role.Owner, Role.Extra)
  async create(@Body() dto: CreatePaymentDto, @Request() req) {
    const payment = await this.paymentsService.create(
      dto,
      req.user as AuthenticatedUser,
    );
    this.auditLogService.log({
      action: 'payment.create',
      actor: { id: req.user.userId, role: req.user.role },
      target: { type: 'payment', id: payment.id },
      status: 'success',
      metadata: { studentId: dto.studentId, courseId: dto.courseId },
    });
    return payment;
  }

  @Get()
  @Roles(Role.Admin, Role.Owner, Role.Extra)
  async getAll(@Query() query: PaymentsListQueryDto, @Request() req) {
    return this.paymentsService.getAll(query, req.user as AuthenticatedUser);
  }

  @Get('me')
  @Roles(Role.Student)
  async getMyPayments(@Request() req, @Query() query: PaymentsListQueryDto) {
    query.studentId = req.user.userId;
    return this.paymentsService.getByStudent(
      req.user.userId,
      query,
      req.user as AuthenticatedUser,
    );
  }

  @Get('student/:studentId')
  @Roles(Role.Admin, Role.Owner, Role.Student, Role.Extra)
  async getByStudent(
    @Param() params: StudentIdParamDto,
    @Request() req,
    @Query() query: PaymentsListQueryDto,
  ) {
    return this.paymentsService.getByStudent(
      params.studentId,
      query,
      req.user as AuthenticatedUser,
    );
  }

  @Get('statistics/summary')
  @Roles(Role.Admin, Role.Owner, Role.Extra)
  async getStatistics(@Query() query: { branchId?: string }, @Request() req) {
    return this.paymentsService.getStatistics(
      req.user as AuthenticatedUser,
      query.branchId,
    );
  }

  @Get('reports/summary')
  @Roles(Role.Admin, Role.Owner, Role.Extra)
  async getReportsSummary(
    @Query() query: PaymentReportsSummaryQueryDto,
    @Request() req,
  ) {
    return this.paymentsService.getReportsSummary(
      query,
      req.user as AuthenticatedUser,
    );
  }

  @Get('reports/debtors')
  @Roles(Role.Admin, Role.Owner, Role.Extra)
  async getDebtorsReport(
    @Query() query: PaymentDebtorsQueryDto,
    @Request() req,
  ) {
    return this.paymentsService.getDebtorsReport(
      query,
      req.user as AuthenticatedUser,
    );
  }

  @Get(':id')
  @Roles(Role.Admin, Role.Owner, Role.Student, Role.Extra)
  async getById(@Param() params: IdParamDto, @Request() req) {
    const payment = await this.paymentsService.getById(
      params.id,
      req.user as AuthenticatedUser,
    );
    return payment;
  }

  @Post(':id/add-payment')
  @Roles(Role.Owner, Role.Extra)
  async addPayment(
    @Param() params: IdParamDto,
    @Body()
    dto: {
      amount: number;
      method: 'cash' | 'card' | 'transfer';
      comment?: string;
    },
    @Request() req,
  ) {
    const payment = await this.paymentsService.addPayment(
      params.id,
      dto.amount,
      dto.method,
      req.user as AuthenticatedUser,
      dto.comment,
    );
    this.auditLogService.log({
      action: 'payment.add_payment',
      actor: { id: req.user.userId, role: req.user.role },
      target: { type: 'payment', id: params.id },
      status: 'success',
      metadata: { amount: dto.amount, method: dto.method },
    });
    return payment;
  }

  @Patch(':id/freeze')
  @Roles(Role.Owner, Role.Extra)
  async freeze(
    @Param() params: IdParamDto,
    @Body() dto: { reason: string; freezeFrom?: Date; freezeTo?: Date },
    @Request() req,
  ) {
    const payment = await this.paymentsService.freezePayment(
      params.id,
      dto.reason,
      req.user as AuthenticatedUser,
      dto.freezeFrom,
      dto.freezeTo,
    );
    return payment;
  }

  @Patch(':id/unfreeze')
  @Roles(Role.Owner, Role.Extra)
  async unfreeze(@Param() params: IdParamDto, @Request() req) {
    const payment = await this.paymentsService.unfreezePayment(
      params.id,
      req.user as AuthenticatedUser,
    );
    return payment;
  }

  @Patch(':id')
  @Roles(Role.Owner, Role.Extra)
  async update(
    @Param() params: IdParamDto,
    @Body() dto: UpdatePaymentDto,
    @Request() req,
  ) {
    const payment = await this.paymentsService.update(
      params.id,
      dto,
      req.user as AuthenticatedUser,
    );
    this.auditLogService.log({
      action: 'payment.update',
      actor: { id: req.user.userId, role: req.user.role },
      target: { type: 'payment', id: params.id },
      status: 'success',
    });
    return payment;
  }

  @Patch(':id/cancel')
  @Roles(Role.Owner, Role.Extra)
  async cancelPayment(@Param() params: IdParamDto, @Request() req) {
    const { id } = params;
    await this.paymentsService.softCancel(id, req.user as AuthenticatedUser);
    return { message: 'Payment cancelled successfully' };
  }
}
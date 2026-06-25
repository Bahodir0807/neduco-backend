import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogService } from '../common/audit/audit-log.service';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  Connection,
  FilterQuery,
  Model,
  PipelineStage,
  SortOrder,
  Types,
} from 'mongoose';
import { Payment, PaymentDocument } from './schemas/payment.schema';
import { PaymentsRepository } from './payments.repository';
import { CreatePaymentDto } from './dto/create-payments.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { Course, CourseDocument } from '../courses/schemas/course.schema';
import { Student, StudentDocument } from '../students/schemas/student.schema';
import { Group, GroupDocument } from '../groups/schemas/group.schema';
import { PaymentsListQueryDto } from './dto/payments-list-query.dto';
import { createPaginatedResult } from '../common/responses/paginated-result';
import { PaginatedResult } from '../common/responses/paginated-result';
import { Role } from '../roles/roles.enum';
import { AuthenticatedUser } from '../common/types/authenticated-user.type';
import { mapPaymentResponse } from './dto/payment-response.dto';
import { PaymentStatus } from './payment-status.enum';
import { PaymentReportsSummaryQueryDto } from './dto/payment-reports-summary-query.dto';
import { PaymentDebtorsQueryDto } from './dto/payment-debtors-query.dto';
import { PaymentsReportsSummaryResponseDto } from './dto/payments-reports-summary-response.dto';
import { PaymentDebtorRowDto } from './dto/payment-debtor-row.dto';
import {
  calculatePaymentLifecycle,
  getPaymentDefaultDueDate,
} from './payment-lifecycle.util';
import { StudentStatus } from '../students/student-status.enum';

export interface GenerateMonthlyPaymentsOptions {
  year: number;
  month: number;
  dryRun?: boolean;
  branchId?: string;
  courseId?: string;
  studentId?: string;
}

export type MonthlyGenerationSkipReason =
  | 'existing'
  | 'inactive'
  | 'missingGroup'
  | 'missingBranch'
  | 'pricingError'
  | 'duplicateRace';

export interface MonthlyGenerationSkippedRecord {
  studentId: string;
  courseId?: string;
  reason: MonthlyGenerationSkipReason;
  detail?: string;
}

export interface GenerateMonthlyPaymentsResult {
  year: number;
  month: number;
  dryRun: boolean;
  filters: {
    branchId?: string;
    courseId?: string;
    studentId?: string;
  };
  scannedStudents: number;
  scannedPairs: number;
  created: number;
  skippedExisting: number;
  skippedRaceDuplicate: number;
  skippedInactive: number;
  skippedMissingGroup: number;
  skippedMissingBranch: number;
  skippedPricingError: number;
  createdPaymentIds: string[];
  skipped: MonthlyGenerationSkippedRecord[];
}

export interface RecalculateDebtAgingOptions {
  dryRun?: boolean;
}

export interface RecalculateDebtAgingResult {
  dryRun: boolean;
  scanned: number;
  changed: number;
  skippedFrozen: number;
  skippedPaid: number;
  skippedOverpaid: number;
  failures: Array<{ paymentId: string; reason: string }>;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly paymentsRepository: PaymentsRepository,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Course.name)
    private readonly courseModel: Model<CourseDocument>,
    @InjectModel(Student.name)
    private readonly studentModel: Model<StudentDocument>,
    @InjectModel(Group.name)
    private readonly groupModel: Model<GroupDocument>,
    private readonly auditLogService: AuditLogService,
  ) {}

  private isRootRole(role?: Role): boolean {
    return role === Role.Owner || role === Role.Extra;
  }

  private isAdminRole(role?: Role): boolean {
    return role === Role.Admin;
  }

  private normalizeBranchIds(branchIds?: unknown[]): string[] {
    return [
      ...new Set(
        (branchIds ?? [])
          .filter((branchId) => branchId !== null && branchId !== undefined)
          .map((branchId) => String(branchId).trim())
          .filter((branchId) => branchId.length > 0),
      ),
    ];
  }

  private ensureScopedActorHasBranches(actor: AuthenticatedUser): string[] {
    const branchIds = this.normalizeBranchIds(actor.branchIds);
    if (!this.isRootRole(actor.role) && branchIds.length === 0) {
      throw new ForbiddenException('User has no assigned branch scope');
    }
    return branchIds;
  }

  private assertPaymentWithinScope(
    actor: AuthenticatedUser,
    payment: Pick<PaymentDocument, 'branchId'>,
  ): void {
    if (this.isRootRole(actor.role)) {
      return;
    }

    if (!this.isAdminRole(actor.role)) {
      return;
    }

    const actorBranches = this.ensureScopedActorHasBranches(actor);
    const paymentBranchId = String(payment.branchId);
    if (!actorBranches.includes(paymentBranchId)) {
      throw new NotFoundException('Payment not found');
    }
  }

  private assertCanReadPayment(
    actor: AuthenticatedUser,
    payment: Pick<PaymentDocument, 'branchId' | 'studentId'>,
  ): void {
    if (this.isRootRole(actor.role)) {
      return;
    }

    if (this.isAdminRole(actor.role)) {
      this.assertPaymentWithinScope(actor, payment);
      return;
    }

    if (
      actor.role === Role.Student &&
      String(payment.studentId) === actor.userId
    ) {
      return;
    }

    throw new ForbiddenException('You are not allowed to access payments');
  }

  private assertCanModifyPayment(actor: AuthenticatedUser): void {
    if (this.isRootRole(actor.role)) {
      return;
    }

    throw new ForbiddenException('Only owner and panda can modify payments');
  }

  private assertActorCanAccessStudent(
    actor: AuthenticatedUser,
    student: Pick<StudentDocument, '_id' | 'branchIds'>,
  ): void {
    if (this.isRootRole(actor.role)) {
      return;
    }

    if (actor.role === Role.Student) {
      if (actor.userId === String(student._id)) {
        return;
      }
      throw new ForbiddenException(
        'Students can only access their own payments',
      );
    }

    if (this.isAdminRole(actor.role)) {
      const actorBranches = this.ensureScopedActorHasBranches(actor);
      const studentBranches = this.normalizeBranchIds(student.branchIds);
      if (
        studentBranches.some((branchId) => actorBranches.includes(branchId))
      ) {
        return;
      }
      throw new NotFoundException('Student not found');
    }

    throw new ForbiddenException('You are not allowed to access payments');
  }

  private getSort(query: PaymentsListQueryDto = {}): Record<string, SortOrder> {
    const sortBy =
      query.sortBy &&
      ['createdAt', 'paymentPeriod', 'expectedAmount'].includes(query.sortBy)
        ? query.sortBy
        : 'paymentPeriod';
    const sortOrder: SortOrder = query.sortOrder === 'asc' ? 'asc' : 'desc';
    return { [sortBy]: sortOrder };
  }

  private buildFilter(
    query: PaymentsListQueryDto = {},
  ): FilterQuery<PaymentDocument> {
    const filter: FilterQuery<PaymentDocument> = {};

    if (query.studentId) {
      filter.studentId = new Types.ObjectId(query.studentId);
    }

    if (query.courseId) {
      filter.courseId = new Types.ObjectId(query.courseId);
    }

    if (query.groupId) {
      filter.groupId = new Types.ObjectId(query.groupId);
    }

    if (query.status) {
      filter.status = query.status;
    }

    if (query.branchId) {
      filter.branchId = new Types.ObjectId(query.branchId);
    }

    return filter;
  }

  private calculatePaymentPeriod(month: number, year: number): string {
    return `${year}-${String(month).padStart(2, '0')}`;
  }

  private getDefaultDueDate(year: number, month: number): Date {
    return getPaymentDefaultDueDate(year, month);
  }

  private validatePaymentData(dto: CreatePaymentDto): void {
    // Edge case: negative amount
    if (dto.paidAmount < 0) {
      throw new BadRequestException('Paid amount cannot be negative');
    }

    // Edge case: zero amount
    if (dto.expectedAmount === 0) {
      throw new BadRequestException('Expected amount must be greater than 0');
    }

    // Edge case: invalid student ID
    if (!Types.ObjectId.isValid(dto.studentId)) {
      throw new BadRequestException('Invalid student ID');
    }

    // Edge case: invalid course ID
    if (!Types.ObjectId.isValid(dto.courseId)) {
      throw new BadRequestException('Invalid course ID');
    }

    // Edge case: invalid group ID
    if (!Types.ObjectId.isValid(dto.groupId)) {
      throw new BadRequestException('Invalid group ID');
    }

    // Edge case: invalid branch ID
    if (!Types.ObjectId.isValid(dto.branchId)) {
      throw new BadRequestException('Invalid branch ID');
    }

    // Edge case: invalid month
    if (dto.month < 1 || dto.month > 12) {
      throw new BadRequestException('Month must be between 1 and 12');
    }

    // Edge case: invalid year
    if (dto.year < 2000 || dto.year > 2100) {
      throw new BadRequestException('Year must be between 2000 and 2100');
    }
  }

  private calculatePaymentStatus(
    expectedAmount: number,
    paidAmount: number,
    dueDate?: Date,
    paymentYear?: number,
    paymentMonth?: number,
  ): PaymentStatus {
    return calculatePaymentLifecycle({
      expectedAmount,
      paidAmount,
      dueDate,
      year: paymentYear,
      month: paymentMonth,
    }).status;
  }

  private applyLifecycle(
    payment: Pick<
      PaymentDocument,
      | 'expectedAmount'
      | 'paidAmount'
      | 'remainingAmount'
      | 'overpaidAmount'
      | 'status'
      | 'isFrozen'
      | 'dueDate'
      | 'year'
      | 'month'
    >,
  ): void {
    const recalculated = calculatePaymentLifecycle({
      expectedAmount: payment.expectedAmount,
      paidAmount: payment.paidAmount,
      dueDate: payment.dueDate,
      year: payment.year,
      month: payment.month,
      isFrozen: payment.isFrozen,
    });
    payment.remainingAmount = recalculated.remainingAmount;
    payment.overpaidAmount = recalculated.overpaidAmount;
    payment.status = recalculated.status;
    if (!payment.dueDate && recalculated.dueDate) {
      payment.dueDate = recalculated.dueDate;
    }
  }

  private async checkDuplicatePayment(
    studentId: string,
    courseId: string,
    month: number,
    year: number,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.paymentsRepository.findOne({
      studentId: new Types.ObjectId(studentId),
      courseId: new Types.ObjectId(courseId),
      month,
      year,
    });

    if (existing && (!excludeId || existing._id.toString() !== excludeId)) {
      throw new ConflictException(
        `Payment for this student-course-month already exists`,
      );
    }
  }

  private async verifyStudentExists(
    studentId: string,
  ): Promise<StudentDocument> {
    const student = await this.studentModel.findById(studentId);
    if (!student) {
      throw new NotFoundException('Student not found');
    }
    return student;
  }

  private async verifyCourseExists(courseId: string): Promise<CourseDocument> {
    const course = await this.courseModel.findById(courseId);
    if (!course) {
      throw new NotFoundException('Course not found');
    }
    return course;
  }

  private async verifyGroupExists(groupId: string): Promise<GroupDocument> {
    const group = await this.groupModel.findById(groupId);
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    return group;
  }

  async resolveExpectedAmount(
    studentId: string,
    courseId: string,
  ): Promise<number> {
    const [student, course] = await Promise.all([
      this.studentModel.findById(studentId, { monthlyPayment: 1 }).lean(),
      this.courseModel.findById(courseId, { price: 1 }).lean(),
    ]);

    if (!student) {
      throw new NotFoundException('Student not found');
    }
    if (!course) {
      throw new NotFoundException('Course not found');
    }
    if (
      typeof student.monthlyPayment === 'number' &&
      student.monthlyPayment > 0
    ) {
      return student.monthlyPayment;
    }
    if (typeof course.price === 'number' && course.price > 0) {
      return course.price;
    }
    throw new BadRequestException(
      'Expected amount is not configured for student or course',
    );
  }

  async create(dto: CreatePaymentDto, actor: AuthenticatedUser): Promise<any> {
    this.assertCanModifyPayment(actor);
    this.validatePaymentData(dto);

    // Verify student exists
    const student = await this.verifyStudentExists(dto.studentId);

    // Check access
    this.assertActorCanAccessStudent(actor, student);

    // Verify course and group exist
    await this.verifyCourseExists(dto.courseId);
    await this.verifyGroupExists(dto.groupId);

    // Edge case: check duplicate payment
    await this.checkDuplicatePayment(
      dto.studentId,
      dto.courseId,
      dto.month,
      dto.year,
    );

    const paymentPeriod = this.calculatePaymentPeriod(dto.month, dto.year);
    const dueDate = dto.dueDate
      ? new Date(dto.dueDate)
      : this.getDefaultDueDate(dto.year, dto.month);
    const status = this.calculatePaymentStatus(
      dto.expectedAmount,
      dto.paidAmount,
      dueDate,
    );
    const remainingAmount = Math.max(0, dto.expectedAmount - dto.paidAmount);
    const overpaidAmount = Math.max(0, dto.paidAmount - dto.expectedAmount);

    const session = await this.connection.startSession();
    session.startTransaction();

    try {
      const paymentData: Record<string, unknown> = {
        studentId: new Types.ObjectId(dto.studentId),
        courseId: new Types.ObjectId(dto.courseId),
        groupId: new Types.ObjectId(dto.groupId),
        branchId: new Types.ObjectId(dto.branchId),
        month: dto.month,
        year: dto.year,
        paymentPeriod,
        dueDate,
        expectedAmount: dto.expectedAmount,
        paidAmount: dto.paidAmount,
        remainingAmount,
        overpaidAmount,
        status,
        isFrozen: false,
        comment: dto.comment,
        paymentHistory: [],
      };

      // Add initial payment history entry if payment was made
      if (dto.paidAmount > 0) {
        paymentData.paymentHistory = [
          {
            amount: dto.paidAmount,
            paidAt: new Date(),
            paymentMethod: (dto.paymentMethod as any) || 'transfer',
            comment: dto.comment,
            createdBy: new Types.ObjectId(actor.userId),
          },
        ];
      }

      const payment = await this.paymentsRepository.create(paymentData, {
        session,
      });

      await session.commitTransaction();

      return mapPaymentResponse(payment);
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async addPayment(
    paymentId: string,
    amount: number,
    method: 'cash' | 'card' | 'transfer',
    actor: AuthenticatedUser,
    comment?: string,
  ): Promise<any> {
    // Edge case: negative amount
    if (amount <= 0) {
      throw new BadRequestException('Payment amount must be greater than 0');
    }

    const payment = await this.paymentsRepository.findById(paymentId);
    if (!payment) {
      throw new NotFoundException('Payment not found');
    }
    this.assertCanReadPayment(actor, payment);
    this.assertCanModifyPayment(actor);

    // Check if frozen
    if (payment.isFrozen) {
      if (payment.freezeTo && new Date() < payment.freezeTo) {
        throw new BadRequestException(
          'Payment is frozen and cannot be modified',
        );
      }
      // Auto-unfreeze if freezeTo date has passed
      payment.isFrozen = false;
      payment.freezeReason = undefined;
      payment.freezeFrom = undefined;
      payment.freezeTo = undefined;
    }

    // Edge case: check duplicate payments in same session
    const totalPaid = payment.paidAmount + amount;

    const session = await this.connection.startSession();
    session.startTransaction();

    try {
      const newPaidAmount = payment.paidAmount + amount;

      // Add to payment history
      payment.paymentHistory.push({
        amount,
        paidAt: new Date(),
        paymentMethod: method,
        comment,
        createdBy: new Types.ObjectId(actor.userId),
      });

      payment.paidAmount = newPaidAmount;
      this.applyLifecycle(payment);

      const updated = await payment.save({ session });
      await session.commitTransaction();

      return mapPaymentResponse(updated);
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async freezePayment(
    paymentId: string,
    reason: string,
    actor: AuthenticatedUser,
    freezeFrom?: Date,
    freezeTo?: Date,
  ): Promise<any> {
    const payment = await this.paymentsRepository.findById(paymentId);
    if (!payment) {
      throw new NotFoundException('Payment not found');
    }
    this.assertCanReadPayment(actor, payment);
    this.assertCanModifyPayment(actor);

    const session = await this.connection.startSession();
    session.startTransaction();

    try {
      payment.isFrozen = true;
      payment.freezeReason = reason;
      payment.freezeFrom = freezeFrom || new Date();
      payment.freezeTo = freezeTo;
      payment.status = PaymentStatus.Frozen;

      const updated = await payment.save({ session });

      this.auditLogService.log({
        action: 'payment.freeze',
        actor: { id: actor.userId, role: actor.role },
        target: { type: 'payment', id: paymentId },
        status: 'success',
        metadata: { reason },
      });

      await session.commitTransaction();
      return mapPaymentResponse(updated);
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async unfreezePayment(
    paymentId: string,
    actor: AuthenticatedUser,
  ): Promise<any> {
    const payment = await this.paymentsRepository.findById(paymentId);
    if (!payment) {
      throw new NotFoundException('Payment not found');
    }
    this.assertCanReadPayment(actor, payment);
    this.assertCanModifyPayment(actor);

    if (!payment.isFrozen) {
      throw new BadRequestException('Payment is not frozen');
    }

    const session = await this.connection.startSession();
    session.startTransaction();

    try {
      payment.isFrozen = false;
      payment.freezeReason = undefined;
      payment.freezeFrom = undefined;
      payment.freezeTo = undefined;

      this.applyLifecycle(payment);

      const updated = await payment.save({ session });

      this.auditLogService.log({
        action: 'payment.unfreeze',
        actor: { id: actor.userId, role: actor.role },
        target: { type: 'payment', id: paymentId },
        status: 'success',
      });

      await session.commitTransaction();
      return mapPaymentResponse(updated);
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async getAll(
    query: PaymentsListQueryDto = {},
    actor: AuthenticatedUser,
  ): Promise<any> {
    const filter = this.buildFilter(query);

    if (this.isAdminRole(actor.role)) {
      const branchIds = this.ensureScopedActorHasBranches(actor);
      filter.branchId = { $in: branchIds.map((id) => new Types.ObjectId(id)) };
    } else if (!this.isRootRole(actor.role)) {
      throw new ForbiddenException('You are not allowed to access payments');
    }

    const sort = this.getSort(query);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.paymentsRepository.find(filter, sort, limit, skip),
      this.paymentsRepository.count(filter),
    ]);

    return createPaginatedResult(
      data.map((p) => mapPaymentResponse(p)),
      total,
      page,
      limit,
    );
  }

  async getByStudent(
    studentId: string,
    query: PaymentsListQueryDto = {},
    actor: AuthenticatedUser,
  ): Promise<any> {
    // ── Task 1: Explicit Ownership Verification (IDOR fix) ──
    if (actor.role === Role.Admin) {
      const student = await this.verifyStudentExists(studentId);
      const actorBranches = this.ensureScopedActorHasBranches(actor);
      const studentBranches = this.normalizeBranchIds(
        (student as unknown as { branchIds?: unknown[] }).branchIds,
      );
      const hasAccess = studentBranches.some((bId) =>
        actorBranches.includes(bId),
      );
      if (!hasAccess) {
        throw new NotFoundException(
          'Студент не найден в вашем филиале',
        );
      }
    } else if (actor.role === Role.Student) {
      if (studentId !== actor.userId) {
        throw new ForbiddenException('You are not allowed to view this student\'s payments');
      }
    }
    // Root roles (Owner, Extra) skip ownership check — full access

    const filter = {
      ...this.buildFilter(query),
      studentId: new Types.ObjectId(studentId),
    };
    const sort = this.getSort(query);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.paymentsRepository.find(filter, sort, limit, skip),
      this.paymentsRepository.count(filter),
    ]);

    return createPaginatedResult(
      data.map((p) => mapPaymentResponse(p)),
      total,
      page,
      limit,
    );
  }

  async getById(id: string, actor: AuthenticatedUser): Promise<any> {
    const payment = await this.paymentsRepository.findById(id);
    if (!payment) {
      throw new NotFoundException('Payment not found');
    }
    this.assertCanReadPayment(actor, payment);
    return mapPaymentResponse(payment);
  }

  async update(
    id: string,
    dto: UpdatePaymentDto,
    actor: AuthenticatedUser,
  ): Promise<any> {
    const payment = await this.paymentsRepository.findById(id);
    if (!payment) {
      throw new NotFoundException('Payment not found');
    }
    this.assertCanReadPayment(actor, payment);
    this.assertCanModifyPayment(actor);

    // Check if can modify
    if (
      payment.isFrozen &&
      (!payment.freezeTo || new Date() < payment.freezeTo)
    ) {
      throw new BadRequestException('Cannot modify frozen payment');
    }

    // Only allow comment or amount updates on locked payments
    if (
      payment.status === PaymentStatus.Paid ||
      payment.status === PaymentStatus.Debt
    ) {
      if (Object.keys(dto).some((key) => key !== 'comment' && key !== 'amount')) {
        throw new BadRequestException('Cannot modify locked payment');
      }
    }

    const updateData: Record<string, unknown> = {};
    if (dto.comment !== undefined) {
      updateData.comment = dto.comment;
    }
    if (dto.amount !== undefined) {
      if (dto.amount <= 0) {
        throw new BadRequestException('Amount must be greater than 0');
      }
      payment.paidAmount = dto.amount;
    }
    if (dto.dueDate !== undefined) {
      payment.dueDate = new Date(dto.dueDate);
    }
    if (dto.amount !== undefined || dto.dueDate !== undefined) {
      this.applyLifecycle(payment);
      updateData.paidAmount = payment.paidAmount;
      updateData.remainingAmount = payment.remainingAmount;
      updateData.overpaidAmount = payment.overpaidAmount;
      updateData.status = payment.status;
      updateData.dueDate = payment.dueDate;
    }

    const updated = await this.paymentsRepository.updateOne(id, updateData);
    return mapPaymentResponse(updated);
  }

  async softCancel(id: string, actor: AuthenticatedUser): Promise<void> {
    const payment = await this.paymentsRepository.findById(id);
    if (!payment) {
      throw new NotFoundException('Payment not found');
    }
    this.assertCanReadPayment(actor, payment);
    this.assertCanModifyPayment(actor);

    // Edge case: already cancelled
    if (payment.status === PaymentStatus.Cancelled) {
      throw new BadRequestException('Payment is already cancelled');
    }

    // Edge case: frozen payment cannot be cancelled
    if (payment.isFrozen) {
      throw new BadRequestException(
        'Cannot cancel a frozen payment. Unfreeze first.',
      );
    }

    const session = await this.connection.startSession();
    session.startTransaction();

    try {
      const oldStatus = payment.status;

      payment.status = PaymentStatus.Cancelled;
      payment.isFrozen = false;
      payment.freezeReason = undefined;
      payment.freezeFrom = undefined;
      payment.freezeTo = undefined;
      payment.comment = payment.comment
        ? `Аннулировано владельцем [${actor.userId}]. ${payment.comment}`
        : `Аннулировано владельцем [${actor.userId}]`;

      await payment.save({ session });

      this.auditLogService.log({
        action: 'payment.cancel',
        actor: { id: actor.userId, role: actor.role },
        target: { type: 'payment', id },
        status: 'success',
        oldValue: { status: oldStatus },
        newValue: { status: PaymentStatus.Cancelled },
      });

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async getStatistics(
    actor: AuthenticatedUser,
    branchId?: string,
  ): Promise<any> {
    return this.getReportsSummary({ branchId }, actor);
  }

  private buildReportFilter(
    query: PaymentReportsSummaryQueryDto | PaymentDebtorsQueryDto,
    actor: AuthenticatedUser,
  ): FilterQuery<PaymentDocument> {
    const filter: FilterQuery<PaymentDocument> = {};
    if (query.courseId) {
      filter.courseId = new Types.ObjectId(query.courseId);
    }
    if (query.year) {
      filter.year = query.year;
    }
    if (query.month) {
      filter.month = query.month;
    }
    if (query.status) {
      filter.status = query.status;
    }

    if (this.isRootRole(actor.role)) {
      if (query.branchId) {
        filter.branchId = new Types.ObjectId(query.branchId);
      }
      return filter;
    }
    if (this.isAdminRole(actor.role)) {
      const branchIds = this.ensureScopedActorHasBranches(actor);
      if (query.branchId && !branchIds.includes(query.branchId)) {
        throw new ForbiddenException('Branch is out of admin scope');
      }
      filter.branchId = query.branchId
        ? new Types.ObjectId(query.branchId)
        : { $in: branchIds.map((id) => new Types.ObjectId(id)) };
      return filter;
    }

    throw new ForbiddenException(
      'You are not allowed to access payment reports',
    );
  }

  async getReportsSummary(
    query: PaymentReportsSummaryQueryDto,
    actor: AuthenticatedUser,
  ): Promise<PaymentsReportsSummaryResponseDto> {
    const filter = this.buildReportFilter(query, actor);
    const result = await this.paymentsRepository.aggregate<any>([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalExpectedAmount: { $sum: '$expectedAmount' },
          totalPaidAmount: { $sum: '$paidAmount' },
          totalRemainingAmount: { $sum: '$remainingAmount' },
          totalOverpaidAmount: { $sum: '$overpaidAmount' },
          totalPaymentsCount: { $sum: 1 },
          paidCount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
          partialCount: {
            $sum: { $cond: [{ $eq: ['$status', 'partial'] }, 1, 0] },
          },
          pendingCount: {
            $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] },
          },
          debtCount: { $sum: { $cond: [{ $eq: ['$status', 'debt'] }, 1, 0] } },
          frozenCount: {
            $sum: { $cond: [{ $eq: ['$status', 'frozen'] }, 1, 0] },
          },
          overpaidCount: {
            $sum: { $cond: [{ $eq: ['$status', 'overpaid'] }, 1, 0] },
          },
          totalDebtAmount: {
            $sum: {
              $cond: [{ $eq: ['$status', 'debt'] }, '$remainingAmount', 0],
            },
          },
        },
      },
    ]);

    return (
      result[0] ?? {
        totalExpectedAmount: 0,
        totalPaidAmount: 0,
        totalRemainingAmount: 0,
        totalOverpaidAmount: 0,
        totalDebtAmount: 0,
        totalPaymentsCount: 0,
        paidCount: 0,
        partialCount: 0,
        pendingCount: 0,
        debtCount: 0,
        frozenCount: 0,
        overpaidCount: 0,
      }
    );
  }

  async getDebtorsReport(
    query: PaymentDebtorsQueryDto,
    actor: AuthenticatedUser,
  ): Promise<PaginatedResult<PaymentDebtorRowDto>> {
    const filter = this.buildReportFilter(query, actor);
    filter.remainingAmount = { $gt: 0 };
    if (!query.status) {
      filter.status = {
        $in: [PaymentStatus.Pending, PaymentStatus.Partial, PaymentStatus.Debt],
      } as any;
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const search = query.search?.trim();

    const pipeline: PipelineStage[] = [{ $match: filter }];

    if (!search) {
      pipeline.push(
        { $sort: { dueDate: 1, createdAt: -1 } },
        {
          $facet: {
            data: [
              { $skip: skip },
              { $limit: limit },
              {
                $lookup: {
                  from: 'students',
                  localField: 'studentId',
                  foreignField: '_id',
                  as: 'student',
                },
              },
              {
                $lookup: {
                  from: 'courses',
                  localField: 'courseId',
                  foreignField: '_id',
                  as: 'course',
                },
              },
              {
                $lookup: {
                  from: 'groups',
                  localField: 'groupId',
                  foreignField: '_id',
                  as: 'group',
                },
              },
              {
                $addFields: {
                  student: { $arrayElemAt: ['$student', 0] },
                  course: { $arrayElemAt: ['$course', 0] },
                  group: { $arrayElemAt: ['$group', 0] },
                },
              },
              {
                $project: {
                  paymentId: '$_id',
                  studentId: '$studentId',
                  studentNumber: '$student.studentNumber',
                  studentName: {
                    $trim: {
                      input: {
                        $concat: [
                          { $ifNull: ['$student.firstName', ''] },
                          ' ',
                          { $ifNull: ['$student.lastName', ''] },
                        ],
                      },
                    },
                  },
                  phone: '$student.phoneNumber',
                  parentPhone: '$student.parentPhoneNumber',
                  courseId: '$courseId',
                  courseName: '$course.name',
                  groupId: '$groupId',
                  groupName: '$group.name',
                  branchId: '$branchId',
                  branchName: { $literal: null },
                  expectedAmount: '$expectedAmount',
                  paidAmount: '$paidAmount',
                  remainingAmount: '$remainingAmount',
                  status: '$status',
                  dueDate: '$dueDate',
                  year: '$year',
                  month: '$month',
                },
              },
            ],
            total: [{ $count: 'count' }],
          },
        },
      );
    } else {
      pipeline.push(
        {
          $lookup: {
            from: 'students',
            localField: 'studentId',
            foreignField: '_id',
            as: 'student',
          },
        },
        {
          $lookup: {
            from: 'courses',
            localField: 'courseId',
            foreignField: '_id',
            as: 'course',
          },
        },
        {
          $lookup: {
            from: 'groups',
            localField: 'groupId',
            foreignField: '_id',
            as: 'group',
          },
        },
        {
          $addFields: {
            student: { $arrayElemAt: ['$student', 0] },
            course: { $arrayElemAt: ['$course', 0] },
            group: { $arrayElemAt: ['$group', 0] },
          },
        },
      );
      pipeline.push({
        $match: {
          $or: [
            { 'student.firstName': { $regex: search, $options: 'i' } },
            { 'student.lastName': { $regex: search, $options: 'i' } },
            { 'student.studentNumber': { $regex: search, $options: 'i' } },
            { 'student.phoneNumber': { $regex: search, $options: 'i' } },
            { 'student.parentPhoneNumber': { $regex: search, $options: 'i' } },
            { 'course.name': { $regex: search, $options: 'i' } },
            { 'group.name': { $regex: search, $options: 'i' } },
          ],
        },
      });
      pipeline.push(
        { $sort: { dueDate: 1, createdAt: -1 } },
        {
          $facet: {
            data: [
              { $skip: skip },
              { $limit: limit },
              {
                $project: {
                  paymentId: '$_id',
                  studentId: '$studentId',
                  studentNumber: '$student.studentNumber',
                  studentName: {
                    $trim: {
                      input: {
                        $concat: [
                          { $ifNull: ['$student.firstName', ''] },
                          ' ',
                          { $ifNull: ['$student.lastName', ''] },
                        ],
                      },
                    },
                  },
                  phone: '$student.phoneNumber',
                  parentPhone: '$student.parentPhoneNumber',
                  courseId: '$courseId',
                  courseName: '$course.name',
                  groupId: '$groupId',
                  groupName: '$group.name',
                  branchId: '$branchId',
                  branchName: { $literal: null },
                  expectedAmount: '$expectedAmount',
                  paidAmount: '$paidAmount',
                  remainingAmount: '$remainingAmount',
                  status: '$status',
                  dueDate: '$dueDate',
                  year: '$year',
                  month: '$month',
                },
              },
            ],
            total: [{ $count: 'count' }],
          },
        },
      );
    }

    const [result] = await this.paymentsRepository.aggregate<any>(pipeline, {
      allowDiskUse: !!search,
    });
    const total = result?.total?.[0]?.count ?? 0;
    const mappedData: PaymentDebtorRowDto[] = (result?.data ?? []).map(
      (row: any) => ({
        ...row,
        paymentId: String(row.paymentId),
        studentId: String(row.studentId),
        courseId: String(row.courseId),
        groupId: String(row.groupId),
        branchId: String(row.branchId),
        dueDate: row.dueDate ? new Date(row.dueDate).toISOString() : undefined,
        branchName: row.branchName ?? null,
      }),
    );

    return createPaginatedResult(mappedData, total, page, limit);
  }

  async generateMonthlyPayments(
    options: GenerateMonthlyPaymentsOptions,
  ): Promise<GenerateMonthlyPaymentsResult> {
    const dryRun = options.dryRun !== false;
    if (options.month < 1 || options.month > 12) {
      throw new BadRequestException('Month must be between 1 and 12');
    }
    if (options.year < 2000 || options.year > 2100) {
      throw new BadRequestException('Year must be between 2000 and 2100');
    }

    const studentFilter: Record<string, unknown> = {
      isActive: true,
      status: StudentStatus.Active,
      courseIds: { $exists: true, $ne: [] },
    };
    if (options.studentId) {
      studentFilter._id = new Types.ObjectId(options.studentId);
    }
    if (options.branchId) {
      studentFilter.branchIds = new Types.ObjectId(options.branchId);
    }
    if (options.courseId) {
      studentFilter.courseIds = new Types.ObjectId(options.courseId);
    }

    const students = await this.studentModel
      .find(studentFilter, {
        _id: 1,
        courseIds: 1,
        groupIds: 1,
        branchIds: 1,
        isActive: 1,
        status: 1,
      })
      .lean()
      .exec();

    const result: GenerateMonthlyPaymentsResult = {
      year: options.year,
      month: options.month,
      dryRun,
      filters: {
        branchId: options.branchId,
        courseId: options.courseId,
        studentId: options.studentId,
      },
      scannedStudents: students.length,
      scannedPairs: 0,
      created: 0,
      skippedExisting: 0,
      skippedRaceDuplicate: 0,
      skippedInactive: 0,
      skippedMissingGroup: 0,
      skippedMissingBranch: 0,
      skippedPricingError: 0,
      createdPaymentIds: [],
      skipped: [],
    };

    for (const student of students) {
      if (
        student.isActive === false ||
        [
          StudentStatus.Inactive,
          StudentStatus.Archived,
          StudentStatus.Deleted,
        ].includes(student.status)
      ) {
        result.skippedInactive += 1;
        result.skipped.push({
          studentId: String(student._id),
          reason: 'inactive',
        });
        continue;
      }

      const candidateCourseIds = Array.from(
        new Set((student.courseIds ?? []).map((id: unknown) => String(id))),
      );
      const courseIds = options.courseId
        ? candidateCourseIds.filter((id) => id === options.courseId)
        : candidateCourseIds;
      const branchIds = Array.isArray(student.branchIds)
        ? Array.from(
            new Set(student.branchIds.map((id: unknown) => String(id))),
          )
        : [];
      const branchId = options.branchId
        ? branchIds.find((id) => id === options.branchId)
        : branchIds.length === 1
          ? branchIds[0]
          : undefined;
      if (!branchId) {
        result.skippedMissingBranch += courseIds.length;
        for (const courseId of courseIds) {
          result.skipped.push({
            studentId: String(student._id),
            courseId,
            reason: 'missingBranch',
            detail:
              branchIds.length > 1
                ? 'Student has multiple branches; specify branchId filter'
                : 'Student has no branch',
          });
        }
        continue;
      }

      for (const courseId of courseIds) {
        result.scannedPairs += 1;
        const existing = await this.paymentsRepository.findOne({
          studentId: new Types.ObjectId(String(student._id)),
          courseId: new Types.ObjectId(courseId),
          year: options.year,
          month: options.month,
        });
        if (existing) {
          result.skippedExisting += 1;
          result.skipped.push({
            studentId: String(student._id),
            courseId,
            reason: 'existing',
          });
          continue;
        }

        const groups = await this.groupModel
          .find(
            {
              _id: { $in: student.groupIds ?? [] },
              course: new Types.ObjectId(courseId),
            },
            { _id: 1 },
          )
          .lean()
          .exec();

        const groupCandidates = groups.map((group) => String(group._id));
        const groupId =
          groupCandidates.length === 1 ? groupCandidates[0] : undefined;
        if (!groupId) {
          result.skippedMissingGroup += 1;
          result.skipped.push({
            studentId: String(student._id),
            courseId,
            reason: 'missingGroup',
            detail:
              groupCandidates.length > 1
                ? 'Multiple groups match course; refine data'
                : 'No group found for student-course pair',
          });
          continue;
        }

        let expectedAmount = 0;
        try {
          expectedAmount = await this.resolveExpectedAmount(
            String(student._id),
            courseId,
          );
        } catch {
          result.skippedPricingError += 1;
          result.skipped.push({
            studentId: String(student._id),
            courseId,
            reason: 'pricingError',
          });
          continue;
        }

        const dueDate = this.getDefaultDueDate(options.year, options.month);
        const lifecycle = calculatePaymentLifecycle({
          expectedAmount,
          paidAmount: 0,
          dueDate,
          year: options.year,
          month: options.month,
          isFrozen: false,
        });

        if (dryRun) {
          result.created += 1;
          result.createdPaymentIds.push(
            `dry-run:${student._id.toString()}:${courseId}:${options.year}-${options.month}`,
          );
          continue;
        }

        try {
          const createdPayment = await this.paymentsRepository.create({
            studentId: new Types.ObjectId(String(student._id)),
            courseId: new Types.ObjectId(courseId),
            groupId: new Types.ObjectId(groupId),
            branchId: new Types.ObjectId(String(branchId)),
            month: options.month,
            year: options.year,
            paymentPeriod: this.calculatePaymentPeriod(
              options.month,
              options.year,
            ),
            dueDate,
            expectedAmount,
            paidAmount: 0,
            remainingAmount: lifecycle.remainingAmount,
            overpaidAmount: lifecycle.overpaidAmount,
            status: lifecycle.status,
            isFrozen: false,
            paymentHistory: [],
          });
          result.created += 1;
          result.createdPaymentIds.push(String(createdPayment._id));
        } catch (error: any) {
          if (error?.code === 11000) {
            result.skippedRaceDuplicate += 1;
            result.skipped.push({
              studentId: String(student._id),
              courseId,
              reason: 'duplicateRace',
            });
            continue;
          }
          throw error;
        }
      }
    }

    return result;
  }

  async recalculateDebtAging(
    options: RecalculateDebtAgingOptions = {},
  ): Promise<RecalculateDebtAgingResult> {
    const dryRun = options.dryRun !== false;
    const payments = await this.paymentsRepository.find({
      status: {
        $in: [
          PaymentStatus.Pending,
          PaymentStatus.Partial,
          PaymentStatus.Debt,
          PaymentStatus.Frozen,
          PaymentStatus.Paid,
          PaymentStatus.Overpaid,
        ],
      },
    });

    const result: RecalculateDebtAgingResult = {
      dryRun,
      scanned: payments.length,
      changed: 0,
      skippedFrozen: 0,
      skippedPaid: 0,
      skippedOverpaid: 0,
      failures: [],
    };

    for (const payment of payments) {
      const paymentId = String(payment._id);
      try {
        if (payment.isFrozen || payment.status === PaymentStatus.Frozen) {
          result.skippedFrozen += 1;
          continue;
        }
        if (payment.status === PaymentStatus.Paid) {
          result.skippedPaid += 1;
          continue;
        }
        if (payment.status === PaymentStatus.Overpaid) {
          result.skippedOverpaid += 1;
          continue;
        }

        const recalculated = calculatePaymentLifecycle({
          expectedAmount: payment.expectedAmount,
          paidAmount: payment.paidAmount,
          dueDate: payment.dueDate,
          year: payment.year,
          month: payment.month,
          isFrozen: payment.isFrozen,
        });

        if (recalculated.status === payment.status) {
          continue;
        }

        result.changed += 1;
        if (!dryRun) {
          await this.paymentsRepository.updateById(paymentId, {
            status: recalculated.status,
            remainingAmount: recalculated.remainingAmount,
            overpaidAmount: recalculated.overpaidAmount,
            dueDate: recalculated.dueDate,
          });
        }
      } catch (error) {
        result.failures.push({
          paymentId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }
}

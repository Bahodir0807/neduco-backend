import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { PaymentsService } from './payments.service';
import { PaymentStatus } from './payment-status.enum';
import { Role } from '../roles/roles.enum';
import { AuthenticatedUser } from '../common/types/authenticated-user.type';
import { PaymentSchema } from './schemas/payment.schema';

function objectId(): string {
  return new Types.ObjectId().toString();
}

function createActor(
  overrides: Partial<AuthenticatedUser> = {},
): AuthenticatedUser {
  return {
    userId: objectId(),
    role: Role.Owner,
    branchIds: [objectId()],
    ...overrides,
  };
}

function createSession() {
  return {
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    abortTransaction: jest.fn(),
    endSession: jest.fn(),
  };
}

function createPaymentDoc(overrides: Record<string, unknown> = {}) {
  const payment = {
    _id: new Types.ObjectId(),
    studentId: new Types.ObjectId(objectId()),
    courseId: new Types.ObjectId(objectId()),
    groupId: new Types.ObjectId(objectId()),
    branchId: new Types.ObjectId(objectId()),
    month: 5,
    year: 2026,
    paymentPeriod: '2026-05',
    expectedAmount: 100,
    paidAmount: 0,
    remainingAmount: 100,
    overpaidAmount: 0,
    status: PaymentStatus.Pending,
    isFrozen: false,
    paymentHistory: [] as Array<Record<string, unknown>>,
    createdAt: new Date(),
    updatedAt: new Date(),
    save: jest.fn(),
    ...overrides,
  };

  payment.save.mockImplementation(async () => payment);
  return payment;
}

function createService() {
  const session = createSession();
  const paymentsRepository = {
    findById: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    updateOne: jest.fn(),
    updateById: jest.fn(),
    deleteOne: jest.fn(),
    aggregate: jest.fn(),
  };
  const connection = {
    startSession: jest.fn(async () => session),
  };
  const courseModel = { findById: jest.fn() };
  const studentModel = { findById: jest.fn(), find: jest.fn() };
  const groupModel = {
    findById: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
  };
  const auditLogService = { log: jest.fn(), logFailure: jest.fn() };

  return {
    service: new PaymentsService(
      paymentsRepository as any,
      connection as any,
      courseModel as any,
      studentModel as any,
      groupModel as any,
      auditLogService as any,
    ),
    paymentsRepository,
    connection,
    session,
    courseModel,
    studentModel,
    groupModel,
  };
}

describe('PaymentsService', () => {
  describe('create', () => {
    it('creates payment with pending status and correct amounts', async () => {
      const {
        service,
        paymentsRepository,
        studentModel,
        courseModel,
        groupModel,
      } = createService();
      const studentId = objectId();
      const courseId = objectId();
      const groupId = objectId();
      const branchId = objectId();
      const actor = createActor();

      studentModel.findById.mockResolvedValue({
        _id: studentId,
        branchIds: [branchId],
      });
      courseModel.findById.mockResolvedValue({ _id: courseId });
      groupModel.findById.mockResolvedValue({ _id: groupId });
      paymentsRepository.findOne.mockResolvedValue(null);

      const created = createPaymentDoc({
        studentId: new Types.ObjectId(studentId),
        courseId: new Types.ObjectId(courseId),
        groupId: new Types.ObjectId(groupId),
        branchId: new Types.ObjectId(branchId),
        expectedAmount: 200,
        paidAmount: 0,
        remainingAmount: 200,
        overpaidAmount: 0,
        status: PaymentStatus.Pending,
        paymentHistory: [],
      });
      paymentsRepository.create.mockResolvedValue(created);

      const result = await service.create(
        {
          studentId,
          courseId,
          groupId,
          branchId,
          month: 5,
          year: 2026,
          expectedAmount: 200,
          paidAmount: 0,
          dueDate: '2100-05-31T23:59:59.999Z',
        },
        actor,
      );

      expect(result.status).toBe(PaymentStatus.Pending);
      expect(result.remainingAmount).toBe(200);
      expect(result.overpaidAmount).toBe(0);
      expect(result.paymentHistory).toHaveLength(0);
    });

    it('creates payment with partial status and initial paymentHistory', async () => {
      const {
        service,
        paymentsRepository,
        studentModel,
        courseModel,
        groupModel,
      } = createService();
      const studentId = objectId();
      const courseId = objectId();
      const groupId = objectId();
      const branchId = objectId();
      const actor = createActor();

      studentModel.findById.mockResolvedValue({
        _id: studentId,
        branchIds: [branchId],
      });
      courseModel.findById.mockResolvedValue({ _id: courseId });
      groupModel.findById.mockResolvedValue({ _id: groupId });
      paymentsRepository.findOne.mockResolvedValue(null);

      const created = createPaymentDoc({
        studentId: new Types.ObjectId(studentId),
        courseId: new Types.ObjectId(courseId),
        groupId: new Types.ObjectId(groupId),
        branchId: new Types.ObjectId(branchId),
        expectedAmount: 100,
        paidAmount: 40,
        remainingAmount: 60,
        overpaidAmount: 0,
        status: PaymentStatus.Partial,
        paymentHistory: [
          {
            amount: 40,
            paidAt: new Date(),
            paymentMethod: 'cash',
            createdBy: new Types.ObjectId(actor.userId),
          },
        ],
      });
      paymentsRepository.create.mockResolvedValue(created);

      const result = await service.create(
        {
          studentId,
          courseId,
          groupId,
          branchId,
          month: 5,
          year: 2026,
          expectedAmount: 100,
          paidAmount: 40,
          paymentMethod: 'cash',
          dueDate: '2100-05-31T23:59:59.999Z',
        },
        actor,
      );

      expect(result.status).toBe(PaymentStatus.Partial);
      expect(result.remainingAmount).toBe(60);
      expect(result.overpaidAmount).toBe(0);
      expect(result.paymentHistory).toHaveLength(1);
      expect(result.paymentHistory[0].amount).toBe(40);
    });

    it('creates payment with paid status when paidAmount equals expectedAmount', async () => {
      const {
        service,
        paymentsRepository,
        studentModel,
        courseModel,
        groupModel,
      } = createService();
      const studentId = objectId();
      const courseId = objectId();
      const groupId = objectId();
      const branchId = objectId();
      const actor = createActor();

      studentModel.findById.mockResolvedValue({
        _id: studentId,
        branchIds: [branchId],
      });
      courseModel.findById.mockResolvedValue({ _id: courseId });
      groupModel.findById.mockResolvedValue({ _id: groupId });
      paymentsRepository.findOne.mockResolvedValue(null);
      paymentsRepository.create.mockResolvedValue(
        createPaymentDoc({
          expectedAmount: 100,
          paidAmount: 100,
          remainingAmount: 0,
          overpaidAmount: 0,
          status: PaymentStatus.Paid,
        }),
      );

      const result = await service.create(
        {
          studentId,
          courseId,
          groupId,
          branchId,
          month: 5,
          year: 2026,
          expectedAmount: 100,
          paidAmount: 100,
          dueDate: '2100-05-31T23:59:59.999Z',
        },
        actor,
      );

      expect(result.status).toBe(PaymentStatus.Paid);
      expect(result.remainingAmount).toBe(0);
      expect(result.overpaidAmount).toBe(0);
    });

    it('sets overpaid status and overpaidAmount on create overpayment', async () => {
      const {
        service,
        paymentsRepository,
        studentModel,
        courseModel,
        groupModel,
      } = createService();
      const studentId = objectId();
      const courseId = objectId();
      const groupId = objectId();
      const branchId = objectId();
      const actor = createActor();

      studentModel.findById.mockResolvedValue({
        _id: studentId,
        branchIds: [branchId],
      });
      courseModel.findById.mockResolvedValue({ _id: courseId });
      groupModel.findById.mockResolvedValue({ _id: groupId });
      paymentsRepository.findOne.mockResolvedValue(null);
      paymentsRepository.create.mockResolvedValue(
        createPaymentDoc({
          expectedAmount: 100,
          paidAmount: 130,
          remainingAmount: 0,
          overpaidAmount: 30,
          status: PaymentStatus.Overpaid,
        }),
      );

      const result = await service.create(
        {
          studentId,
          courseId,
          groupId,
          branchId,
          month: 5,
          year: 2026,
          expectedAmount: 100,
          paidAmount: 130,
          dueDate: '2100-05-31T23:59:59.999Z',
        },
        actor,
      );

      expect(result.status).toBe(PaymentStatus.Overpaid);
      expect(result.remainingAmount).toBe(0);
      expect(result.overpaidAmount).toBe(30);
    });

    it('sets debt when payment is overdue and has remaining amount', async () => {
      const {
        service,
        paymentsRepository,
        studentModel,
        courseModel,
        groupModel,
      } = createService();
      const studentId = objectId();
      const courseId = objectId();
      const groupId = objectId();
      const branchId = objectId();
      const actor = createActor();

      studentModel.findById.mockResolvedValue({
        _id: studentId,
        branchIds: [branchId],
      });
      courseModel.findById.mockResolvedValue({ _id: courseId });
      groupModel.findById.mockResolvedValue({ _id: groupId });
      paymentsRepository.findOne.mockResolvedValue(null);
      paymentsRepository.create.mockResolvedValue(
        createPaymentDoc({
          expectedAmount: 100,
          paidAmount: 10,
          remainingAmount: 90,
          status: PaymentStatus.Debt,
        }),
      );

      const result = await service.create(
        {
          studentId,
          courseId,
          groupId,
          branchId,
          month: 1,
          year: 2025,
          expectedAmount: 100,
          paidAmount: 10,
          dueDate: '2025-01-31T23:59:59.999Z',
        },
        actor,
      );

      expect(result.status).toBe(PaymentStatus.Debt);
    });

    it('throws on invalid studentId', async () => {
      const { service } = createService();
      const actor = createActor();

      await expect(
        service.create(
          {
            studentId: 'bad-id',
            courseId: objectId(),
            groupId: objectId(),
            branchId: objectId(),
            month: 5,
            year: 2026,
            expectedAmount: 100,
            paidAmount: 0,
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws on invalid courseId/groupId/branchId', async () => {
      const { service } = createService();
      const actor = createActor();

      await expect(
        service.create(
          {
            studentId: objectId(),
            courseId: 'bad-id',
            groupId: objectId(),
            branchId: objectId(),
            month: 5,
            year: 2026,
            expectedAmount: 100,
            paidAmount: 0,
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.create(
          {
            studentId: objectId(),
            courseId: objectId(),
            groupId: 'bad-id',
            branchId: objectId(),
            month: 5,
            year: 2026,
            expectedAmount: 100,
            paidAmount: 0,
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.create(
          {
            studentId: objectId(),
            courseId: objectId(),
            groupId: objectId(),
            branchId: 'bad-id',
            month: 5,
            year: 2026,
            expectedAmount: 100,
            paidAmount: 0,
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when expectedAmount is zero', async () => {
      const { service } = createService();
      const actor = createActor();

      await expect(
        service.create(
          {
            studentId: objectId(),
            courseId: objectId(),
            groupId: objectId(),
            branchId: objectId(),
            month: 5,
            year: 2026,
            expectedAmount: 0,
            paidAmount: 0,
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when paidAmount is negative', async () => {
      const { service } = createService();
      const actor = createActor();

      await expect(
        service.create(
          {
            studentId: objectId(),
            courseId: objectId(),
            groupId: objectId(),
            branchId: objectId(),
            month: 5,
            year: 2026,
            expectedAmount: 100,
            paidAmount: -1,
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('addPayment', () => {
    it('updates to full payment and keeps history entries', async () => {
      const { service, paymentsRepository } = createService();
      const actor = createActor();
      const payment = createPaymentDoc({
        expectedAmount: 100,
        paidAmount: 40,
        remainingAmount: 60,
        overpaidAmount: 0,
        status: PaymentStatus.Partial,
        paymentHistory: [
          {
            amount: 40,
            paidAt: new Date('2026-05-01T00:00:00.000Z'),
            paymentMethod: 'cash',
            createdBy: new Types.ObjectId(actor.userId),
          },
        ],
      });

      paymentsRepository.findById.mockResolvedValue(payment);

      const result = await service.addPayment(
        payment._id.toString(),
        60,
        'card',
        actor,
        'rest',
      );

      expect(result.status).toBe(PaymentStatus.Paid);
      expect(result.paidAmount).toBe(100);
      expect(result.remainingAmount).toBe(0);
      expect(result.overpaidAmount).toBe(0);
      expect(result.paymentHistory).toHaveLength(2);
      expect(result.paymentHistory[0].amount).toBe(40);
      expect(result.paymentHistory[1].amount).toBe(60);
    });

    it('sets overpaid status and overpaidAmount on overpayment', async () => {
      const { service, paymentsRepository } = createService();
      const actor = createActor();
      const payment = createPaymentDoc({
        expectedAmount: 100,
        paidAmount: 90,
        remainingAmount: 10,
        status: PaymentStatus.Partial,
      });
      paymentsRepository.findById.mockResolvedValue(payment);

      const result = await service.addPayment(
        payment._id.toString(),
        20,
        'transfer',
        actor,
      );

      expect(result.status).toBe(PaymentStatus.Overpaid);
      expect(result.paidAmount).toBe(110);
      expect(result.remainingAmount).toBe(0);
      expect(result.overpaidAmount).toBe(10);
    });

    it('rejects zero and negative addPayment amount', async () => {
      const { service } = createService();
      const actor = createActor();

      await expect(
        service.addPayment(objectId(), 0, 'cash', actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.addPayment(objectId(), -10, 'cash', actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects payment changes when payment is frozen', async () => {
      const { service, paymentsRepository } = createService();
      const actor = createActor();
      const payment = createPaymentDoc({
        isFrozen: true,
        freezeTo: new Date(Date.now() + 60_000),
      });
      paymentsRepository.findById.mockResolvedValue(payment);

      await expect(
        service.addPayment(payment._id.toString(), 10, 'cash', actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('freezePayment', () => {
    it('sets payment status to frozen', async () => {
      const { service, paymentsRepository } = createService();
      const payment = createPaymentDoc();
      paymentsRepository.findById.mockResolvedValue(payment);

      const result = await service.freezePayment(
        payment._id.toString(),
        'manual hold',
        createActor(),
      );

      expect(result.status).toBe(PaymentStatus.Frozen);
      expect(result.isFrozen).toBe(true);
      expect(result.freezeReason).toBe('manual hold');
    });

    it('throws for missing payment', async () => {
      const { service, paymentsRepository } = createService();
      paymentsRepository.findById.mockResolvedValue(null);
      await expect(
        service.freezePayment(objectId(), 'reason', createActor()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('rbac hardening', () => {
    it('allows panda to modify payments', async () => {
      const { service, paymentsRepository } = createService();
      const actor = createActor({ role: Role.Extra });
      const payment = createPaymentDoc();
      paymentsRepository.findById.mockResolvedValue(payment);

      const result = await service.addPayment(
        payment._id.toString(),
        10,
        'cash',
        actor,
      );

      expect(result.paidAmount).toBe(payment.paidAmount);
      expect(payment.save).toHaveBeenCalled();
    });

    it('blocks admin from modifying payments', async () => {
      const { service, paymentsRepository } = createService();
      const actor = createActor({ role: Role.Admin });
      const payment = createPaymentDoc({
        branchId: new Types.ObjectId(actor.branchIds?.[0]),
      });
      paymentsRepository.findById.mockResolvedValue(payment);

      await expect(
        service.addPayment(payment._id.toString(), 10, 'cash', actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows admin to read only in own branch scope', async () => {
      const { service, paymentsRepository } = createService();
      const branchInScope = objectId();
      const actor = createActor({
        role: Role.Admin,
        branchIds: [branchInScope],
      });
      const payment = createPaymentDoc({
        _id: new Types.ObjectId(objectId()),
        branchId: new Types.ObjectId(branchInScope),
      });
      paymentsRepository.findById.mockResolvedValue(payment);

      const result = await service.getById(payment._id.toString(), actor);
      expect(result.id).toBe(payment._id.toString());
    });

    it('blocks student from reading чужие payments', async () => {
      const { service, paymentsRepository } = createService();
      const actor = createActor({ role: Role.Student });
      const payment = createPaymentDoc({
        studentId: new Types.ObjectId(objectId()),
      });
      paymentsRepository.findById.mockResolvedValue(payment);

      await expect(
        service.getById(payment._id.toString(), actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('resolveExpectedAmount', () => {
    it('uses student.monthlyPayment first', async () => {
      const { service, studentModel, courseModel } = createService();
      studentModel.findById.mockReturnValue({
        lean: () => Promise.resolve({ monthlyPayment: 350 }),
      });
      courseModel.findById.mockReturnValue({
        lean: () => Promise.resolve({ price: 500 }),
      });

      await expect(
        service.resolveExpectedAmount(objectId(), objectId()),
      ).resolves.toBe(350);
    });

    it('falls back to course.price', async () => {
      const { service, studentModel, courseModel } = createService();
      studentModel.findById.mockReturnValue({
        lean: () => Promise.resolve({ monthlyPayment: 0 }),
      });
      courseModel.findById.mockReturnValue({
        lean: () => Promise.resolve({ price: 500 }),
      });

      await expect(
        service.resolveExpectedAmount(objectId(), objectId()),
      ).resolves.toBe(500);
    });

    it('throws controlled error if no price is configured', async () => {
      const { service, studentModel, courseModel } = createService();
      studentModel.findById.mockReturnValue({
        lean: () => Promise.resolve({ monthlyPayment: 0 }),
      });
      courseModel.findById.mockReturnValue({
        lean: () => Promise.resolve({ price: 0 }),
      });

      await expect(
        service.resolveExpectedAmount(objectId(), objectId()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('reports', () => {
    it('summary empty result returns zeros', async () => {
      const { service, paymentsRepository } = createService();
      paymentsRepository.aggregate.mockResolvedValue([]);

      const result = await service.getReportsSummary({}, createActor());
      expect(result).toMatchObject({
        totalExpectedAmount: 0,
        totalPaidAmount: 0,
        totalRemainingAmount: 0,
        totalOverpaidAmount: 0,
        totalDebtAmount: 0,
        totalPaymentsCount: 0,
      });
    });

    it('owner sees global summary', async () => {
      const { service, paymentsRepository } = createService();
      paymentsRepository.aggregate.mockResolvedValue([
        { totalExpectedAmount: 1000 },
      ]);

      const result = await service.getReportsSummary({}, createActor());
      expect(result.totalExpectedAmount).toBe(1000);
    });

    it('panda sees global summary', async () => {
      const { service, paymentsRepository } = createService();
      paymentsRepository.aggregate.mockResolvedValue([
        { totalPaymentsCount: 2 },
      ]);

      const result = await service.getReportsSummary(
        {},
        createActor({ role: Role.Extra }),
      );
      expect(result.totalPaymentsCount).toBe(2);
    });

    it('admin sees only branch-scoped summary', async () => {
      const { service, paymentsRepository } = createService();
      const branchId = objectId();
      paymentsRepository.aggregate.mockResolvedValue([
        { totalPaymentsCount: 1 },
      ]);

      await service.getReportsSummary(
        {},
        createActor({ role: Role.Admin, branchIds: [branchId] }),
      );

      const pipeline = paymentsRepository.aggregate.mock.calls[0][0];
      expect(pipeline[0].$match.branchId).toEqual({
        $in: [new Types.ObjectId(branchId)],
      });
    });

    it('teacher is forbidden', async () => {
      const { service } = createService();
      await expect(
        service.getReportsSummary({}, createActor({ role: Role.Teacher })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('debtors list returns required fields and paginates', async () => {
      const { service, paymentsRepository } = createService();
      const branchId = objectId();
      const paymentId = objectId();
      const studentId = objectId();
      const courseId = objectId();
      const groupId = objectId();
      paymentsRepository.aggregate.mockResolvedValue([
        {
          data: [
            {
              paymentId,
              studentId,
              studentNumber: 'ST-0001',
              studentName: 'Ali Valiyev',
              phone: '+998901112233',
              parentPhone: '+998909998877',
              courseId,
              courseName: 'Math',
              groupId,
              groupName: 'G1',
              branchId,
              branchName: null,
              expectedAmount: 100,
              paidAmount: 30,
              remainingAmount: 70,
              status: PaymentStatus.Partial,
              dueDate: new Date('2026-05-31T23:59:59.999Z'),
              year: 2026,
              month: 5,
            },
          ],
          total: [{ count: 1 }],
        },
      ]);

      const result = await service.getDebtorsReport(
        { page: 1, limit: 10 },
        createActor(),
      );

      expect(result.items[0]).toMatchObject({
        paymentId,
        studentNumber: 'ST-0001',
        courseName: 'Math',
        branchName: null,
      });
      expect(typeof result.items[0].dueDate).toBe('string');
      expect(result.pagination.total).toBe(1);
    });
  });

  describe('response contract', () => {
    it('returns dueDate as ISO string', async () => {
      const { service, paymentsRepository } = createService();
      const payment = createPaymentDoc({
        dueDate: new Date('2026-05-31T23:59:59.999Z'),
      });
      paymentsRepository.findById.mockResolvedValue(payment);

      const result = await service.getById(
        payment._id.toString(),
        createActor(),
      );
      expect(result.dueDate).toBe('2026-05-31T23:59:59.999Z');
    });
  });

  describe('recalculateDebtAging', () => {
    it('changes overdue pending and partial payments to debt', async () => {
      const { service, paymentsRepository } = createService();
      const pending = createPaymentDoc({
        year: 2020,
        month: 1,
        dueDate: new Date('2020-01-31T23:59:59.999Z'),
        status: PaymentStatus.Pending,
        paidAmount: 0,
        expectedAmount: 100,
      });
      const partial = createPaymentDoc({
        year: 2020,
        month: 1,
        dueDate: new Date('2020-01-31T23:59:59.999Z'),
        status: PaymentStatus.Partial,
        paidAmount: 50,
        expectedAmount: 100,
      });
      paymentsRepository.find.mockResolvedValue([pending, partial]);
      paymentsRepository.updateById.mockResolvedValue(null);

      const result = await service.recalculateDebtAging({ dryRun: false });

      expect(result.changed).toBe(2);
      expect(paymentsRepository.updateById).toHaveBeenCalledTimes(2);
      expect(paymentsRepository.updateById).toHaveBeenCalledWith(
        pending._id.toString(),
        expect.objectContaining({ status: PaymentStatus.Debt }),
      );
    });

    it('leaves frozen and paid payments untouched', async () => {
      const { service, paymentsRepository } = createService();
      paymentsRepository.find.mockResolvedValue([
        createPaymentDoc({ isFrozen: true, status: PaymentStatus.Frozen }),
        createPaymentDoc({ status: PaymentStatus.Paid, paidAmount: 100 }),
        createPaymentDoc({ status: PaymentStatus.Overpaid, paidAmount: 150 }),
      ]);

      const result = await service.recalculateDebtAging({ dryRun: false });

      expect(result.skippedFrozen).toBe(1);
      expect(result.skippedPaid).toBe(1);
      expect(result.skippedOverpaid).toBe(1);
      expect(paymentsRepository.updateById).not.toHaveBeenCalled();
    });

    it('continues when one payment update fails', async () => {
      const { service, paymentsRepository } = createService();
      const first = createPaymentDoc({
        year: 2020,
        month: 1,
        dueDate: new Date('2020-01-31T23:59:59.999Z'),
        status: PaymentStatus.Pending,
      });
      const second = createPaymentDoc({
        year: 2020,
        month: 1,
        dueDate: new Date('2020-01-31T23:59:59.999Z'),
        status: PaymentStatus.Partial,
        paidAmount: 10,
      });
      paymentsRepository.find.mockResolvedValue([first, second]);
      paymentsRepository.updateById
        .mockRejectedValueOnce(new Error('write failed'))
        .mockResolvedValueOnce(null);

      const result = await service.recalculateDebtAging({ dryRun: false });

      expect(result.changed).toBe(2);
      expect(result.failures).toHaveLength(1);
      expect(paymentsRepository.updateById).toHaveBeenCalledTimes(2);
    });

    it('dry-run does not mutate debt aging candidates', async () => {
      const { service, paymentsRepository } = createService();
      paymentsRepository.find.mockResolvedValue([
        createPaymentDoc({
          year: 2020,
          month: 1,
          dueDate: new Date('2020-01-31T23:59:59.999Z'),
          status: PaymentStatus.Pending,
        }),
      ]);

      const result = await service.recalculateDebtAging({ dryRun: true });

      expect(result.changed).toBe(1);
      expect(paymentsRepository.updateById).not.toHaveBeenCalled();
    });
  });

  describe('generateMonthlyPayments', () => {
    it('has DB unique index for studentId+courseId+year+month', () => {
      const indexes = PaymentSchema.indexes();
      expect(
        indexes.some(
          ([fields, options]) =>
            JSON.stringify(fields) ===
              JSON.stringify({
                studentId: 1,
                courseId: 1,
                year: 1,
                month: 1,
              }) && options.unique === true,
        ),
      ).toBe(true);
    });

    it('prevents duplicates by studentId+courseId+year+month', async () => {
      const { service, studentModel, paymentsRepository } = createService();
      const studentId = objectId();
      const courseId = objectId();
      const groupId = objectId();
      const branchId = objectId();

      studentModel.find.mockReturnValue({
        lean: () =>
          ({
            exec: async () => [
              {
                _id: studentId,
                courseIds: [courseId],
                groupIds: [groupId],
                branchIds: [branchId],
                isActive: true,
                status: 'active',
              },
            ],
          }) as any,
      });
      paymentsRepository.findOne.mockResolvedValue({ _id: objectId() });

      const result = await service.generateMonthlyPayments({
        year: 2026,
        month: 5,
        dryRun: true,
      });

      expect(result.skippedExisting).toBe(1);
      expect(result.created).toBe(0);
      expect(result.skipped[0].reason).toBe('existing');
    });

    it('handles duplicate key race as duplicateRace skip', async () => {
      const {
        service,
        studentModel,
        groupModel,
        paymentsRepository,
        courseModel,
      } = createService();
      const studentId = objectId();
      const courseId = objectId();
      const groupId = objectId();
      const branchId = objectId();

      studentModel.find.mockReturnValue({
        lean: () =>
          ({
            exec: async () => [
              {
                _id: studentId,
                courseIds: [courseId],
                groupIds: [groupId],
                branchIds: [branchId],
                isActive: true,
                status: 'active',
              },
            ],
          }) as any,
      });
      paymentsRepository.findOne.mockResolvedValue(null);
      groupModel.find.mockReturnValue({
        lean: () => ({ exec: async () => [{ _id: groupId }] }),
      });
      studentModel.findById.mockReturnValue({
        lean: () => Promise.resolve({ monthlyPayment: 300 }),
      });
      courseModel.findById.mockReturnValue({
        lean: () => Promise.resolve({ price: 500 }),
      });
      const duplicateError = new Error('duplicate key') as Error & {
        code?: number;
      };
      duplicateError.code = 11000;
      paymentsRepository.create.mockRejectedValue(duplicateError);

      const result = await service.generateMonthlyPayments({
        year: 2026,
        month: 12,
        dryRun: false,
      });

      expect(result.created).toBe(0);
      expect(result.skippedRaceDuplicate).toBe(1);
      expect(result.skipped[0].reason).toBe('duplicateRace');
    });

    it('uses pricing fallback and sets dueDate/lifecycle status', async () => {
      const {
        service,
        studentModel,
        groupModel,
        paymentsRepository,
        courseModel,
      } = createService();
      const studentId = objectId();
      const courseId = objectId();
      const groupId = objectId();
      const branchId = objectId();

      studentModel.find.mockReturnValue({
        lean: () =>
          ({
            exec: async () => [
              {
                _id: studentId,
                courseIds: [courseId],
                groupIds: [groupId],
                branchIds: [branchId],
                isActive: true,
                status: 'active',
              },
            ],
          }) as any,
      });
      paymentsRepository.findOne.mockResolvedValue(null);
      groupModel.find.mockReturnValue({
        lean: () => ({ exec: async () => [{ _id: groupId }] }),
      });
      studentModel.findById.mockReturnValue({
        lean: () => Promise.resolve({ monthlyPayment: 0 }),
      });
      courseModel.findById.mockReturnValue({
        lean: () => Promise.resolve({ price: 500 }),
      });
      paymentsRepository.create.mockResolvedValue(createPaymentDoc());

      const result = await service.generateMonthlyPayments({
        year: 2025,
        month: 1,
        dryRun: false,
      });

      expect(result.created).toBe(1);
      expect(paymentsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedAmount: 500,
          dueDate: new Date('2025-01-31T23:59:59.999Z'),
          status: PaymentStatus.Debt,
        }),
      );
    });

    it('skips when student has multiple branches without branch filter', async () => {
      const { service, studentModel } = createService();
      const studentId = objectId();
      const courseId = objectId();
      const groupId = objectId();

      studentModel.find.mockReturnValue({
        lean: () =>
          ({
            exec: async () => [
              {
                _id: studentId,
                courseIds: [courseId],
                groupIds: [groupId],
                branchIds: [objectId(), objectId()],
                isActive: true,
                status: 'active',
              },
            ],
          }) as any,
      });

      const result = await service.generateMonthlyPayments({
        year: 2026,
        month: 12,
        dryRun: true,
      });

      expect(result.skippedMissingBranch).toBe(1);
      expect(result.skipped[0].reason).toBe('missingBranch');
    });

    it('skips when multiple groups match student-course', async () => {
      const {
        service,
        studentModel,
        groupModel,
        paymentsRepository,
        courseModel,
      } = createService();
      const studentId = objectId();
      const courseId = objectId();
      const groupId = objectId();
      const branchId = objectId();

      studentModel.find.mockReturnValue({
        lean: () =>
          ({
            exec: async () => [
              {
                _id: studentId,
                courseIds: [courseId],
                groupIds: [groupId],
                branchIds: [branchId],
                isActive: true,
                status: 'active',
              },
            ],
          }) as any,
      });
      paymentsRepository.findOne.mockResolvedValue(null);
      groupModel.find.mockReturnValue({
        lean: () => ({
          exec: async () => [{ _id: objectId() }, { _id: objectId() }],
        }),
      });
      studentModel.findById.mockReturnValue({
        lean: () => Promise.resolve({ monthlyPayment: 300 }),
      });
      courseModel.findById.mockReturnValue({
        lean: () => Promise.resolve({ price: 500 }),
      });

      const result = await service.generateMonthlyPayments({
        year: 2026,
        month: 12,
        dryRun: false,
      });

      expect(result.skippedMissingGroup).toBe(1);
      expect(result.skipped[0].reason).toBe('missingGroup');
    });

    it('supports branchId/courseId/studentId filters', async () => {
      const { service, studentModel } = createService();
      studentModel.find.mockReturnValue({
        lean: () =>
          ({
            exec: async () => [],
          }) as any,
      });

      await service.generateMonthlyPayments({
        year: 2026,
        month: 12,
        dryRun: true,
        branchId: objectId(),
        courseId: objectId(),
        studentId: objectId(),
      });

      expect(studentModel.find).toHaveBeenCalled();
      const filter = studentModel.find.mock.calls[0][0];
      expect(filter).toMatchObject({
        _id: expect.any(Types.ObjectId),
        branchIds: expect.any(Types.ObjectId),
        courseIds: expect.any(Types.ObjectId),
      });
    });

    it('dry-run does not create records', async () => {
      const {
        service,
        studentModel,
        groupModel,
        paymentsRepository,
        courseModel,
      } = createService();
      const studentId = objectId();
      const courseId = objectId();
      const groupId = objectId();
      const branchId = objectId();

      studentModel.find.mockReturnValue({
        lean: () =>
          ({
            exec: async () => [
              {
                _id: studentId,
                courseIds: [courseId],
                groupIds: [groupId],
                branchIds: [branchId],
                isActive: true,
                status: 'active',
              },
            ],
          }) as any,
      });
      paymentsRepository.findOne.mockResolvedValue(null);
      groupModel.find.mockReturnValue({
        lean: () => ({ exec: async () => [{ _id: groupId }] }),
      });
      studentModel.findById.mockReturnValue({
        lean: () => Promise.resolve({ monthlyPayment: 300 }),
      });
      courseModel.findById.mockReturnValue({
        lean: () => Promise.resolve({ price: 500 }),
      });

      const result = await service.generateMonthlyPayments({
        year: 2026,
        month: 12,
        dryRun: true,
      });

      expect(result.created).toBe(1);
      expect(result.createdPaymentIds[0]).toContain('dry-run:');
      expect(paymentsRepository.create).not.toHaveBeenCalled();
    });
  });
});

import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { StudentsService } from './students/students.service';
import { PaymentsService } from './payments/payments.service';
import { AttendanceService } from './attendance/attendance.service';
import { Role } from './roles/roles.enum';

function objectId() {
  return new Types.ObjectId().toString();
}

function chain<T>(value: T) {
  const query: Record<string, jest.Mock> = {
    lean: jest.fn(() => query),
    exec: jest.fn(async () => value),
    sort: jest.fn(() => query),
    skip: jest.fn(() => query),
    limit: jest.fn(() => query),
    populate: jest.fn(() => query),
  };
  return query;
}

describe('student auth decoupling', () => {
  it('can create student without linked user account', async () => {
    const createdPayloads: Array<Record<string, unknown>> = [];
    const studentModel = {
      exists: jest.fn(() => chain(null)),
      create: jest.fn(async (payload: Record<string, unknown>) => {
        createdPayloads.push(payload);
        return {
          _id: new Types.ObjectId(),
          firstName: payload.firstName,
          lastName: payload.lastName,
          studentNumber: payload.studentNumber,
          groupIds: [],
          courseIds: [],
          branchIds: [],
          isActive: true,
          status: 'active',
        };
      }),
      countDocuments: jest.fn(() => chain(0)),
      findOne: jest.fn(() => chain(null)),
    };
    const service = new StudentsService(
      studentModel as any,
      { countDocuments: jest.fn(() => chain(0)) } as any,
      { countDocuments: jest.fn(() => chain(0)) } as any,
    );

    const result = await service.create(
      {
        firstName: 'Ali',
        lastName: 'Valiyev',
      },
      { userId: objectId(), role: Role.Owner, branchIds: [] },
    );

    expect(createdPayloads[0]).not.toHaveProperty('userAccountId');
    expect(createdPayloads[0]).toHaveProperty('studentNumber');
    expect(result.studentNumber).toBeDefined();
  });

  it('creates payment for student without linked user account', async () => {
    const session = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      abortTransaction: jest.fn(),
      endSession: jest.fn(),
    };
    const studentId = objectId();
    const courseId = objectId();
    const groupId = objectId();
    const branchId = objectId();
    const paymentsRepository = {
      findOne: jest.fn(async () => null),
      create: jest.fn(async (payload: Record<string, unknown>) => ({
        _id: new Types.ObjectId(),
        ...payload,
        save: jest.fn(),
      })),
    };
    const service = new PaymentsService(
      paymentsRepository as any,
      { startSession: jest.fn(async () => session) } as any,
      { findById: jest.fn(async () => ({ _id: courseId })) } as any,
      {
        findById: jest.fn(async () => ({
          _id: studentId,
          branchIds: [branchId],
        })),
      } as any,
      { findById: jest.fn(async () => ({ _id: groupId })) } as any,
      { log: jest.fn() } as any,
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
        paidAmount: 0,
      },
      { userId: objectId(), role: Role.Owner, branchIds: [] },
    );

    expect(result.studentId).toBe(studentId);
  });

  it('marks attendance for student without linked user account', async () => {
    const studentId = objectId();
    const scheduleId = objectId();
    const attendanceModel = {
      findOneAndUpdate: jest.fn(() => ({
        populate: jest.fn(() => chain({ _id: objectId(), user: studentId })),
      })),
    };
    const service = new AttendanceService(
      attendanceModel as any,
      {
        findById: jest.fn(() =>
          chain({
            _id: studentId,
            branchIds: [objectId()],
            isActive: true,
          }),
        ),
      } as any,
      {
        findById: jest.fn(() =>
          chain({
            _id: scheduleId,
            teacher: objectId(),
            group: null,
            students: [studentId],
          }),
        ),
      } as any,
      {
        findById: jest.fn(() => chain(null)),
        find: jest.fn(() => chain([])),
      } as any,
    );

    await expect(
      service.markAttendance(
        {
          userId: studentId,
          scheduleId,
          date: '2026-05-20',
          status: 'present',
        },
        { userId: objectId(), role: Role.Owner, branchIds: [] },
      ),
    ).resolves.toBeDefined();
  });
});

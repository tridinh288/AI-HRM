import argon2 from 'argon2';
import { sql } from 'drizzle-orm';

import { db } from '../../src/db/client.js';
import {
  attendanceRecords,
  departments,
  employees,
  leaveBalances,
  leaveRequests,
  leaveTypes,
  positions,
  users,
  type Role,
} from '../../src/db/schema.js';

export const TEST_PASSWORD = 'TestPassw0rd!';

/**
 * Argon2 is deliberately slow — 64 MB and three passes per hash. Hashing it once
 * per process and reusing the result turns a suite that would spend most of its
 * time on key derivation into one that spends it on the code under test.
 * Correctness of the hashing itself is covered separately, in the auth tests.
 */
let cachedHash: Promise<string> | null = null;

function testPasswordHash(): Promise<string> {
  cachedHash ??= argon2.hash(TEST_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 8192, // lowered for test speed only; production uses 64 MB
    timeCost: 2,
    parallelism: 1,
  });
  return cachedHash;
}

/**
 * Wipes every table between tests.
 *
 * TRUNCATE ... CASCADE rather than deleting in dependency order: it is one
 * statement, it cannot get the order wrong, and it resets the tables completely.
 * Each test file starts from a known-empty database, so tests cannot depend on
 * each other's leftovers — which is also why the suite runs single-threaded
 * (see vitest.config.ts).
 */
export async function resetDatabase(): Promise<void> {
  await db.execute(sql`
    truncate table
      ai_tool_invocations, ai_messages, ai_conversations,
      audit_logs, refresh_tokens,
      leave_requests, leave_balances, attendance_records,
      employees, users, leave_types, positions, departments
    restart identity cascade
  `);
}

export interface BasicFixtures {
  departmentId: string;
  otherDepartmentId: string;
  positionId: string;
  annualLeaveTypeId: string;
  unpaidLeaveTypeId: string;
}

export async function seedReferenceData(): Promise<BasicFixtures> {
  const [engineering, sales] = await db
    .insert(departments)
    .values([
      { code: 'ENG', name: 'Engineering' },
      { code: 'SAL', name: 'Sales' },
    ])
    .returning({ id: departments.id });

  const [position] = await db
    .insert(positions)
    .values({ title: 'Backend Developer', level: 'MID' })
    .returning({ id: positions.id });

  const [annual, unpaid] = await db
    .insert(leaveTypes)
    .values([
      { code: 'ANNUAL', name: 'Annual Leave', defaultDays: 12, isPaid: true },
      { code: 'UNPAID', name: 'Unpaid Leave', defaultDays: 0, isPaid: false },
    ])
    .returning({ id: leaveTypes.id });

  return {
    departmentId: engineering!.id,
    otherDepartmentId: sales!.id,
    positionId: position!.id,
    annualLeaveTypeId: annual!.id,
    unpaidLeaveTypeId: unpaid!.id,
  };
}

export interface TestUser {
  userId: string;
  employeeId: string;
  email: string;
  employeeCode: string;
  role: Role;
}

let sequence = 0;

/**
 * Creates a user with an attached employee record and this year's leave balance.
 *
 * Inserted directly rather than through the API, because a test about leave
 * approval should fail when leave approval breaks — not when employee creation
 * does. Employee creation has its own tests.
 */
export async function createTestUser(options?: {
  role?: Role;
  email?: string;
  departmentId?: string | null;
  positionId?: string | null;
  entitledDays?: number;
  annualLeaveTypeId?: string;
  baseSalary?: number;
  withEmployee?: boolean;
}): Promise<TestUser> {
  sequence += 1;
  const role = options?.role ?? 'EMPLOYEE';
  const email = options?.email ?? `user${sequence}@test.local`;

  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: await testPasswordHash(), role, isActive: true })
    .returning({ id: users.id });

  if (options?.withEmployee === false) {
    return {
      userId: user!.id,
      employeeId: '',
      email,
      employeeCode: '',
      role,
    };
  }

  const employeeCode = `EMP${String(sequence).padStart(4, '0')}`;

  const [employee] = await db
    .insert(employees)
    .values({
      userId: user!.id,
      employeeCode,
      firstName: 'Test',
      lastName: `User${sequence}`,
      hireDate: '2024-01-15',
      departmentId: options?.departmentId ?? null,
      positionId: options?.positionId ?? null,
      employmentStatus: 'ACTIVE',
      baseSalary: String(options?.baseSalary ?? 20_000_000),
    })
    .returning({ id: employees.id });

  if (options?.annualLeaveTypeId) {
    await db.insert(leaveBalances).values({
      employeeId: employee!.id,
      leaveTypeId: options.annualLeaveTypeId,
      year: new Date().getFullYear(),
      entitledDays: options.entitledDays ?? 12,
      usedDays: 0,
    });
  }

  return { userId: user!.id, employeeId: employee!.id, email, employeeCode, role };
}

export async function createLeaveRequest(input: {
  employeeId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
}): Promise<string> {
  const decided = input.status === 'APPROVED' || input.status === 'REJECTED';

  const [row] = await db
    .insert(leaveRequests)
    .values({
      employeeId: input.employeeId,
      leaveTypeId: input.leaveTypeId,
      startDate: input.startDate,
      endDate: input.endDate,
      totalDays: input.totalDays,
      reason: 'Fixture leave request',
      status: input.status ?? 'PENDING',
      decidedAt: decided ? new Date() : null,
    })
    .returning({ id: leaveRequests.id });

  return row!.id;
}

export async function createAttendance(input: {
  employeeId: string;
  workDate: string;
  checkInAt?: Date;
  checkOutAt?: Date;
  status?: 'PRESENT' | 'LATE' | 'ON_LEAVE';
  lateMinutes?: number;
  workMinutes?: number;
}): Promise<string> {
  const [row] = await db
    .insert(attendanceRecords)
    .values({
      employeeId: input.employeeId,
      workDate: input.workDate,
      checkInAt: input.checkInAt ?? null,
      checkOutAt: input.checkOutAt ?? null,
      status: input.status ?? 'PRESENT',
      lateMinutes: input.lateMinutes ?? 0,
      workMinutes: input.workMinutes ?? 0,
    })
    .returning({ id: attendanceRecords.id });

  return row!.id;
}

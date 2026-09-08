/**
 * Seed data.
 *
 * A portfolio project with an empty database is a portfolio project nobody can
 * evaluate: every dashboard is zeroes, every chart is blank, and the AI
 * assistant has nothing to answer questions about. This script builds a company
 * that looks real — ~50 people across five departments, three months of
 * attendance, and a spread of leave requests in every state.
 *
 * It is deterministic. The pseudo-random generator below is seeded with a
 * constant, so the same command produces the same company every time: a
 * screenshot in the README still matches the data, and a failing test is
 * reproducible rather than "sometimes".
 */

import argon2 from 'argon2';
import { sql } from 'drizzle-orm';

import { companyPolicy } from '../config/env.js';
import { evaluateCheckIn, evaluateCheckOut } from '../modules/attendance/attendance.policy.js';
import { countWorkingDays, isWeekend } from '../shared/calendar.js';
import { closeDatabase, db } from './client.js';
import {
  attendanceRecords,
  departments,
  employees,
  leaveBalances,
  leaveRequests,
  leaveTypes,
  positions,
  users,
} from './schema.js';

// ---------------------------------------------------------------------------
// Deterministic randomness (mulberry32)
// ---------------------------------------------------------------------------

function createRandom(seed: number) {
  let state = seed;
  return function random(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = createRandom(20260908);

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function randomInt(min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const DEPARTMENTS = [
  { code: 'ENG', name: 'Engineering', description: 'Product engineering and platform' },
  { code: 'HR', name: 'Human Resources', description: 'People operations and recruitment' },
  { code: 'FIN', name: 'Finance', description: 'Accounting, payroll and reporting' },
  { code: 'MKT', name: 'Marketing', description: 'Brand, content and growth' },
  { code: 'SAL', name: 'Sales', description: 'Direct sales and account management' },
] as const;

const POSITIONS = [
  { title: 'Backend Developer', level: 'MID' },
  { title: 'Frontend Developer', level: 'MID' },
  { title: 'QA Engineer', level: 'JUNIOR' },
  { title: 'Engineering Manager', level: 'MANAGER' },
  { title: 'HR Specialist', level: 'MID' },
  { title: 'Accountant', level: 'MID' },
  { title: 'Marketing Executive', level: 'JUNIOR' },
  { title: 'Sales Executive', level: 'JUNIOR' },
  { title: 'Product Manager', level: 'SENIOR' },
  { title: 'Intern', level: 'INTERN' },
] as const;

const LEAVE_TYPES = [
  {
    code: 'ANNUAL',
    name: 'Annual Leave',
    description: 'Paid annual entitlement',
    defaultDays: companyPolicy.annualLeaveDays,
    isPaid: true,
  },
  {
    code: 'SICK',
    name: 'Sick Leave',
    description: 'Paid sick leave',
    defaultDays: 6,
    isPaid: true,
  },
  {
    code: 'PERSONAL',
    name: 'Personal Leave',
    description: 'Paid personal days',
    defaultDays: 3,
    isPaid: true,
  },
  {
    code: 'UNPAID',
    name: 'Unpaid Leave',
    description: 'Leave without pay; not drawn from an entitlement',
    defaultDays: 0,
    isPaid: false,
  },
] as const;

const FAMILY_NAMES = [
  'Nguyen', 'Tran', 'Le', 'Pham', 'Hoang', 'Phan', 'Vu', 'Dang',
  'Bui', 'Do', 'Ho', 'Ngo', 'Duong', 'Ly', 'Trinh',
] as const;

const GIVEN_NAMES = [
  'An', 'Binh', 'Chau', 'Dung', 'Giang', 'Ha', 'Hieu', 'Hoa', 'Khanh', 'Lan',
  'Linh', 'Mai', 'Minh', 'Nam', 'Nga', 'Ngoc', 'Nhung', 'Phuc', 'Quang', 'Quynh',
  'Son', 'Thanh', 'Thao', 'Thu', 'Trang', 'Trung', 'Tuan', 'Tu', 'Vy', 'Yen',
] as const;

const LEAVE_REASONS = [
  'Family trip planned in advance',
  'Medical appointment',
  'Personal matters to settle',
  'Attending a relative\'s wedding',
  'Recovering from flu',
  'Moving house',
  'Childcare during school holidays',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/**
 * Builds a UTC instant for a given company-local wall-clock time.
 *
 * The seed has to speak the same language as the attendance rules: "checked in
 * at 08:15 local" is what the policy evaluates, so the seed constructs the UTC
 * instant that corresponds to it (+07:00 for Ho Chi Minh City) rather than
 * hoping the server's timezone happens to match.
 */
function localTimeToInstant(date: string, hour: number, minute: number): Date {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+07:00`);
}

async function hash(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const DEMO_PASSWORD = 'DemoPassw0rd!';

async function seed(): Promise<void> {
  console.log('Clearing existing data…');

  // TRUNCATE ... CASCADE in one statement: order-independent, and far faster
  // than deleting table by table in dependency order.
  await db.execute(sql`
    truncate table
      ai_tool_invocations, ai_messages, ai_conversations,
      audit_logs, refresh_tokens,
      leave_requests, leave_balances, attendance_records,
      employees, users, leave_types, positions, departments
    restart identity cascade
  `);

  console.log('Inserting departments, positions and leave types…');

  const departmentRows = await db
    .insert(departments)
    .values(DEPARTMENTS.map((d) => ({ ...d })))
    .returning({ id: departments.id, code: departments.code });

  const positionRows = await db
    .insert(positions)
    .values(POSITIONS.map((p) => ({ title: p.title, level: p.level })))
    .returning({ id: positions.id, title: positions.title });

  const leaveTypeRows = await db
    .insert(leaveTypes)
    .values(LEAVE_TYPES.map((t) => ({ ...t })))
    .returning({
      id: leaveTypes.id,
      code: leaveTypes.code,
      defaultDays: leaveTypes.defaultDays,
      isPaid: leaveTypes.isPaid,
    });

  const departmentByCode = new Map(departmentRows.map((row) => [row.code, row.id]));
  const positionByTitle = new Map(positionRows.map((row) => [row.title, row.id]));

  console.log('Creating users and employees…');

  const passwordHash = await hash(DEMO_PASSWORD);
  const today = new Date();
  const currentYear = today.getUTCFullYear();

  interface SeedPerson {
    email: string;
    role: 'ADMIN' | 'HR' | 'EMPLOYEE';
    firstName: string;
    lastName: string;
    departmentCode: string;
    positionTitle: string;
    salary: number;
  }

  // Three demo logins, one per role — the accounts a reviewer will actually use.
  const demoPeople: SeedPerson[] = [
    {
      email: 'admin@hrm.local',
      role: 'ADMIN',
      firstName: 'Quang',
      lastName: 'Nguyen',
      departmentCode: 'ENG',
      positionTitle: 'Engineering Manager',
      salary: 65_000_000,
    },
    {
      email: 'hr@hrm.local',
      role: 'HR',
      firstName: 'Mai',
      lastName: 'Tran',
      departmentCode: 'HR',
      positionTitle: 'HR Specialist',
      salary: 28_000_000,
    },
    {
      email: 'employee@hrm.local',
      role: 'EMPLOYEE',
      firstName: 'Linh',
      lastName: 'Pham',
      departmentCode: 'ENG',
      positionTitle: 'Backend Developer',
      salary: 32_000_000,
    },
  ];

  const generated: SeedPerson[] = [];
  const usedEmails = new Set(demoPeople.map((p) => p.email));

  for (let i = 0; i < 47; i += 1) {
    const lastName = pick(FAMILY_NAMES);
    const firstName = pick(GIVEN_NAMES);
    const department = pick(DEPARTMENTS);

    // Position is drawn from the department's plausible roles, so the org chart
    // does not end up with accountants in Engineering.
    const positionTitle =
      department.code === 'ENG'
        ? pick(['Backend Developer', 'Frontend Developer', 'QA Engineer', 'Product Manager', 'Intern'])
        : department.code === 'HR'
          ? 'HR Specialist'
          : department.code === 'FIN'
            ? 'Accountant'
            : department.code === 'MKT'
              ? 'Marketing Executive'
              : 'Sales Executive';

    let email = `${firstName}.${lastName}${i}`.toLowerCase() + '@hrm.local';
    while (usedEmails.has(email)) email = `x${email}`;
    usedEmails.add(email);

    generated.push({
      email,
      role: 'EMPLOYEE',
      firstName,
      lastName,
      departmentCode: department.code,
      positionTitle,
      salary: randomInt(12, 45) * 1_000_000,
    });
  }

  const allPeople = [...demoPeople, ...generated];

  const userRows = await db
    .insert(users)
    .values(
      allPeople.map((person) => ({
        email: person.email,
        passwordHash,
        role: person.role,
        isActive: true,
      })),
    )
    .returning({ id: users.id, email: users.email });

  const userIdByEmail = new Map(userRows.map((row) => [row.email, row.id]));

  const employeeRows = await db
    .insert(employees)
    .values(
      allPeople.map((person, index) => {
        // Hire dates spread over the past four years, so "employee growth" on
        // the dashboard is a real curve rather than a single spike.
        const hireDate = addDays(today, -randomInt(30, 1460));
        return {
          userId: userIdByEmail.get(person.email)!,
          employeeCode: `EMP${String(index + 1).padStart(4, '0')}`,
          firstName: person.firstName,
          lastName: person.lastName,
          phone: `09${randomInt(10_000_000, 99_999_999)}`,
          dateOfBirth: isoDate(addDays(today, -randomInt(8000, 16000))),
          gender: pick(['MALE', 'FEMALE', 'OTHER'] as const),
          address: `${randomInt(1, 200)} Nguyen Hue, District 1, Ho Chi Minh City`,
          hireDate: isoDate(hireDate),
          departmentId: departmentByCode.get(person.departmentCode)!,
          positionId: positionByTitle.get(person.positionTitle)!,
          employmentStatus: 'ACTIVE' as const,
          baseSalary: String(person.salary),
        };
      }),
    )
    .returning({ id: employees.id, employeeCode: employees.employeeCode });

  // Two former employees, so the TERMINATED path has real data behind it and
  // "active vs total headcount" is not the same number.
  await db
    .update(employees)
    .set({ employmentStatus: 'TERMINATED', terminatedAt: addDays(today, -45) })
    .where(sql`${employees.employeeCode} in ('EMP0049', 'EMP0050')`);

  await db
    .update(users)
    .set({ isActive: false })
    .where(
      sql`${users.id} in (select ${employees.userId} from ${employees}
          where ${employees.employmentStatus} = 'TERMINATED')`,
    );

  console.log(`  ${employeeRows.length} employees created.`);

  console.log('Creating leave balances…');

  await db.insert(leaveBalances).values(
    employeeRows.flatMap((employee) =>
      leaveTypeRows.map((type) => ({
        employeeId: employee.id,
        leaveTypeId: type.id,
        year: currentYear,
        entitledDays: type.defaultDays,
        usedDays: 0,
      })),
    ),
  );

  console.log('Generating three months of attendance…');

  const attendanceValues: (typeof attendanceRecords.$inferInsert)[] = [];
  const activeEmployees = employeeRows.filter(
    (row) => row.employeeCode !== 'EMP0049' && row.employeeCode !== 'EMP0050',
  );

  for (let dayOffset = 90; dayOffset >= 0; dayOffset -= 1) {
    const day = addDays(today, -dayOffset);
    const workDate = isoDate(day);
    if (isWeekend(workDate)) continue;

    for (const employee of activeEmployees) {
      // ~4% of working days are absences: no row at all, which is exactly how
      // the real system behaves — absence is derived, never stored.
      if (random() < 0.04) continue;

      // Most people arrive on time; a minority are late, occasionally very.
      const roll = random();
      const arrivalMinute =
        roll < 0.72
          ? randomInt(-25, 4) // early or comfortably on time
          : roll < 0.94
            ? randomInt(6, 25) // mildly late
            : randomInt(26, 75); // seriously late

      const checkInAt = localTimeToInstant(workDate, 8, 0);
      checkInAt.setUTCMinutes(checkInAt.getUTCMinutes() + arrivalMinute);

      const checkIn = evaluateCheckIn(checkInAt, companyPolicy);

      // A few people forget to check out; that record stays open, which is the
      // realistic case the UI has to handle.
      const forgotCheckOut = random() < 0.03;

      if (forgotCheckOut) {
        attendanceValues.push({
          employeeId: employee.id,
          workDate,
          checkInAt,
          status: checkIn.status,
          lateMinutes: checkIn.lateMinutes,
        });
        continue;
      }

      const departureMinute = random() < 0.18 ? randomInt(-60, -5) : randomInt(0, 120);
      const checkOutAt = localTimeToInstant(workDate, 17, 30);
      checkOutAt.setUTCMinutes(checkOutAt.getUTCMinutes() + departureMinute);

      const checkOut = evaluateCheckOut(checkInAt, checkOutAt, companyPolicy);

      attendanceValues.push({
        employeeId: employee.id,
        workDate,
        checkInAt,
        checkOutAt,
        status: checkIn.status,
        lateMinutes: checkIn.lateMinutes,
        earlyLeaveMinutes: checkOut.earlyLeaveMinutes,
        workMinutes: checkOut.workMinutes,
        overtimeMinutes: checkOut.overtimeMinutes,
      });
    }
  }

  // Inserted in chunks: a single INSERT with ~3,000 rows exceeds the parameter
  // limit of the PostgreSQL wire protocol (65,535 bound parameters).
  const CHUNK = 500;
  for (let i = 0; i < attendanceValues.length; i += CHUNK) {
    await db.insert(attendanceRecords).values(attendanceValues.slice(i, i + CHUNK));
  }
  console.log(`  ${attendanceValues.length} attendance records created.`);

  console.log('Generating leave requests…');

  const annualType = leaveTypeRows.find((type) => type.code === 'ANNUAL')!;
  const sickType = leaveTypeRows.find((type) => type.code === 'SICK')!;
  const adminUserId = userIdByEmail.get('admin@hrm.local')!;

  const usedDaysByEmployee = new Map<string, number>();

  for (const employee of activeEmployees) {
    const requestCount = randomInt(0, 3);

    for (let i = 0; i < requestCount; i += 1) {
      const type = random() < 0.7 ? annualType : sickType;
      const start = addDays(today, randomInt(-60, 25));
      const startDate = isoDate(start);
      const endDate = isoDate(addDays(start, randomInt(0, 4)));

      const totalDays = countWorkingDays(startDate, endDate);
      if (totalDays === 0) continue;

      // Only ANNUAL is capped here; keeping the seed within the entitlement
      // means the `leave_balance_within_entitlement` CHECK constraint is
      // satisfied by construction rather than by luck.
      const alreadyUsed = usedDaysByEmployee.get(employee.id) ?? 0;
      const status =
        start < today
          ? random() < 0.75
            ? 'APPROVED'
            : 'REJECTED'
          : random() < 0.5
            ? 'PENDING'
            : 'APPROVED';

      if (
        status === 'APPROVED' &&
        type.isPaid &&
        alreadyUsed + totalDays > (type.defaultDays || 0)
      ) {
        continue;
      }

      const decided = status === 'APPROVED' || status === 'REJECTED';

      await db.insert(leaveRequests).values({
        employeeId: employee.id,
        leaveTypeId: type.id,
        startDate,
        endDate,
        totalDays,
        reason: pick(LEAVE_REASONS),
        status,
        decidedById: decided ? adminUserId : null,
        decidedAt: decided ? addDays(start, -2) : null,
        decisionNote: status === 'REJECTED' ? 'Team capacity is too low that week' : null,
      });

      if (status === 'APPROVED' && type.isPaid) {
        usedDaysByEmployee.set(employee.id, alreadyUsed + totalDays);
        await db
          .update(leaveBalances)
          .set({ usedDays: sql`${leaveBalances.usedDays} + ${totalDays}` })
          .where(
            sql`${leaveBalances.employeeId} = ${employee.id}
                and ${leaveBalances.leaveTypeId} = ${type.id}
                and ${leaveBalances.year} = ${currentYear}`,
          );
      }
    }
  }

  const leaveCountRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(leaveRequests);
  console.log(`  ${leaveCountRows[0]?.count ?? 0} leave requests created.`);

  console.log('\nSeed complete. Demo accounts (all share the same password):');
  console.table([
    { role: 'ADMIN', email: 'admin@hrm.local', password: DEMO_PASSWORD },
    { role: 'HR', email: 'hr@hrm.local', password: DEMO_PASSWORD },
    { role: 'EMPLOYEE', email: 'employee@hrm.local', password: DEMO_PASSWORD },
  ]);
}

seed()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Seed failed:', error);
    await closeDatabase();
    process.exit(1);
  });

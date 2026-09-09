/**
 * Seed data.
 *
 * A portfolio project with an empty database is a portfolio project nobody can
 * evaluate: every dashboard is zeroes, every chart is blank, and the AI
 * assistant has nothing to answer questions about. This script builds a company
 * that looks real — 500 people across five departments, three months of
 * attendance, and a spread of leave requests in every state.
 *
 * Two properties are worth knowing before running it.
 *
 * **It never deletes anything on its own.** The seed fills an *empty* database.
 * If accounts already exist it stops and changes nothing, because the data in a
 * running system is the one thing a convenience script must not be able to
 * take away. Wiping is a separate, explicit decision: `--reset`.
 *
 * **Every account has its own password.** The three demo logins documented in
 * the README keep the documented password so that the README stays true. The
 * other 497 get a random one each, written to a git-ignored CSV for whoever
 * operates the system — never printed to the console, never shown in the app.
 *
 * Everything except those passwords is deterministic. The pseudo-random
 * generator below is seeded with a constant, so the same command produces the
 * same company every time: a screenshot in the README still matches the data,
 * and a failing test is reproducible rather than "sometimes". Passwords are the
 * deliberate exception — deriving them from a constant that lives in a public
 * repository would make every one of them guessable.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { inArray, sql } from 'drizzle-orm';

import { companyPolicy } from '../config/env.js';
import { evaluateCheckIn, evaluateCheckOut } from '../modules/attendance/attendance.policy.js';
import { hashPassword } from '../modules/auth/auth.service.js';
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

/** Picks by weight, so the org chart has a shape rather than five equal slices. */
function pickWeighted<T>(items: readonly { value: T; weight: number }[]): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item.value;
  }
  return items[items.length - 1]!.value;
}

// ---------------------------------------------------------------------------
// Size and reference data
// ---------------------------------------------------------------------------

/** Total accounts, demo logins included. */
const TOTAL_PEOPLE = 500;

/** Argon2 at production cost takes about a second per hash on a laptop; sixteen
 *  in flight keeps the run around two minutes instead of eight. */
const HASH_CONCURRENCY = 16;

/** Where the generated credentials go. Relative to the working directory,
 *  which is `backend/` when run through npm and `/app` inside the container. */
const CREDENTIALS_FILE = path.resolve(process.cwd(), 'seed-output', 'accounts.csv');

const DEPARTMENTS = [
  { code: 'ENG', name: 'Engineering', description: 'Product engineering and platform', weight: 36 },
  { code: 'SAL', name: 'Sales', description: 'Direct sales and account management', weight: 24 },
  { code: 'MKT', name: 'Marketing', description: 'Brand, content and growth', weight: 15 },
  { code: 'FIN', name: 'Finance', description: 'Accounting, payroll and reporting', weight: 15 },
  { code: 'HR', name: 'Human Resources', description: 'People operations and recruitment', weight: 10 },
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

/** Positions that make sense in each department, so the org chart does not end
 *  up with accountants in Engineering. */
const POSITIONS_BY_DEPARTMENT: Record<string, readonly (typeof POSITIONS)[number]['title'][]> = {
  ENG: ['Backend Developer', 'Frontend Developer', 'QA Engineer', 'Product Manager', 'Intern'],
  SAL: ['Sales Executive', 'Intern'],
  MKT: ['Marketing Executive', 'Intern'],
  FIN: ['Accountant'],
  HR: ['HR Specialist'],
};

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
  'Bui', 'Do', 'Ho', 'Ngo', 'Duong', 'Ly', 'Trinh', 'Dinh', 'Mai', 'Vo',
] as const;

const GIVEN_NAMES = [
  'An', 'Binh', 'Chau', 'Dung', 'Giang', 'Ha', 'Hieu', 'Hoa', 'Khanh', 'Lan',
  'Linh', 'Mai', 'Minh', 'Nam', 'Nga', 'Ngoc', 'Nhung', 'Phuc', 'Quang', 'Quynh',
  'Son', 'Thanh', 'Thao', 'Thu', 'Trang', 'Trung', 'Tuan', 'Tu', 'Vy', 'Yen',
  'Bao', 'Dat', 'Hai', 'Hung', 'Huy', 'Kiet', 'Long', 'Nhi', 'Phong', 'Tam',
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

/**
 * A password someone can type from the CSV: 12 characters from a URL-safe
 * alphabet, drawn from the OS entropy source rather than the seeded generator
 * above. Comfortably clears the 10-character minimum the API enforces.
 */
function generatePassword(): string {
  return randomBytes(9).toString('base64url');
}

/** Quotes a CSV field only when it has to be quoted. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const DEMO_PASSWORD = 'DemoPassw0rd!';

interface SeedPerson {
  email: string;
  password: string;
  passwordHash?: string;
  role: 'ADMIN' | 'HR' | 'EMPLOYEE';
  firstName: string;
  lastName: string;
  departmentCode: string;
  positionTitle: string;
  salary: number;
  /** The demo logins are documented in the README; nobody else is. */
  isDemo: boolean;
}

async function seed(): Promise<void> {
  const reset = process.argv.includes('--reset');

  const [existing] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  const existingAccounts = existing?.count ?? 0;

  if (existingAccounts > 0 && !reset) {
    console.log(
      `The database already holds ${existingAccounts} user accounts. Nothing was changed.\n` +
        'The seed only fills an empty database. To discard everything in it and rebuild:\n' +
        '  npm run db:seed -- --reset',
    );
    return;
  }

  if (reset) {
    console.log(`--reset: discarding ${existingAccounts} accounts and everything attached to them…`);
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
  }

  console.log('Inserting departments, positions and leave types…');

  const departmentRows = await db
    .insert(departments)
    .values(DEPARTMENTS.map(({ weight: _weight, ...d }) => ({ ...d })))
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

  console.log(`Generating ${TOTAL_PEOPLE} people…`);

  const today = new Date();
  const currentYear = today.getUTCFullYear();

  // Three demo logins, one per role — the accounts a reviewer will actually use.
  const demoPeople: SeedPerson[] = [
    {
      email: 'admin@hrm.local',
      password: DEMO_PASSWORD,
      role: 'ADMIN',
      firstName: 'Quang',
      lastName: 'Nguyen',
      departmentCode: 'ENG',
      positionTitle: 'Engineering Manager',
      salary: 65_000_000,
      isDemo: true,
    },
    {
      email: 'hr@hrm.local',
      password: DEMO_PASSWORD,
      role: 'HR',
      firstName: 'Mai',
      lastName: 'Tran',
      departmentCode: 'HR',
      positionTitle: 'HR Specialist',
      salary: 28_000_000,
      isDemo: true,
    },
    {
      email: 'employee@hrm.local',
      password: DEMO_PASSWORD,
      role: 'EMPLOYEE',
      firstName: 'Linh',
      lastName: 'Pham',
      departmentCode: 'ENG',
      positionTitle: 'Backend Developer',
      salary: 32_000_000,
      isDemo: true,
    },
  ];

  const generated: SeedPerson[] = [];
  const usedEmails = new Set(demoPeople.map((p) => p.email));

  for (let i = 0; i < TOTAL_PEOPLE - demoPeople.length; i += 1) {
    const lastName = pick(FAMILY_NAMES);
    const firstName = pick(GIVEN_NAMES);
    const department = pickWeighted(DEPARTMENTS.map((d) => ({ value: d, weight: d.weight })));
    const positionTitle = pick(POSITIONS_BY_DEPARTMENT[department.code]!);

    let email = `${firstName}.${lastName}${i + 1}`.toLowerCase() + '@hrm.local';
    while (usedEmails.has(email)) email = `x${email}`;
    usedEmails.add(email);

    // A handful of HR accounts besides the demo one, so "HR" is a team and not
    // a single person; the ADMIN role stays unique.
    const role = department.code === 'HR' && random() < 0.3 ? 'HR' : 'EMPLOYEE';

    generated.push({
      email,
      password: generatePassword(),
      role,
      firstName,
      lastName,
      departmentCode: department.code,
      positionTitle,
      salary:
        positionTitle === 'Intern'
          ? randomInt(6, 10) * 1_000_000
          : positionTitle === 'Product Manager'
            ? randomInt(40, 70) * 1_000_000
            : randomInt(12, 45) * 1_000_000,
      isDemo: false,
    });
  }

  const allPeople = [...demoPeople, ...generated];

  console.log(`Hashing ${allPeople.length} passwords (argon2id, ${HASH_CONCURRENCY} at a time)…`);

  // The demo password is hashed once and shared; every other person gets their
  // own hash. Argon2 is deliberately slow, which is why this is the one step
  // that runs concurrently.
  const demoHash = await hashPassword(DEMO_PASSWORD);
  const toHash = allPeople.filter((person) => !person.isDemo);
  for (const person of demoPeople) person.passwordHash = demoHash;

  for (let i = 0; i < toHash.length; i += HASH_CONCURRENCY) {
    const batch = toHash.slice(i, i + HASH_CONCURRENCY);
    await Promise.all(
      batch.map(async (person) => {
        person.passwordHash = await hashPassword(person.password);
      }),
    );
    const done = Math.min(i + HASH_CONCURRENCY, toHash.length);
    if (done % (HASH_CONCURRENCY * 5) === 0 || done === toHash.length) {
      console.log(`  ${done}/${toHash.length}`);
    }
  }

  console.log('Creating users and employees…');

  const userRows = await db
    .insert(users)
    .values(
      allPeople.map((person) => ({
        email: person.email,
        passwordHash: person.passwordHash!,
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
    .returning({ id: employees.id, employeeCode: employees.employeeCode, userId: employees.userId });

  // About 3% are former employees, so the TERMINATED path has real data behind
  // it and "active vs total headcount" is not the same number. Demo logins are
  // never among them — a reviewer's first sign-in must not be a locked account.
  const demoUserIds = new Set(demoPeople.map((p) => userIdByEmail.get(p.email)!));
  const terminated = employeeRows.filter((row) => !demoUserIds.has(row.userId) && random() < 0.03);
  const terminatedEmployeeIds = new Set(terminated.map((row) => row.id));

  if (terminated.length > 0) {
    await db
      .update(employees)
      .set({ employmentStatus: 'TERMINATED', terminatedAt: addDays(today, -randomInt(10, 200)) })
      .where(inArray(employees.id, terminated.map((row) => row.id)));

    await db
      .update(users)
      .set({ isActive: false })
      .where(inArray(users.id, terminated.map((row) => row.userId)));
  }

  console.log(`  ${employeeRows.length} employees created (${terminated.length} former).`);

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
  const activeEmployees = employeeRows.filter((row) => !terminatedEmployeeIds.has(row.id));

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

  // Inserted in chunks: the PostgreSQL wire protocol allows 65,535 bound
  // parameters per statement, and ~30,000 rows of nine columns is well past it.
  const CHUNK = 2000;
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

  // Credentials go to a file, not the console: 500 passwords scrolling past in
  // a terminal are both useless and a habit worth not forming. The file is
  // git-ignored.
  const employeeCodeByUserId = new Map(employeeRows.map((row) => [row.userId, row.employeeCode]));
  const departmentNameByCode = new Map<string, string>(DEPARTMENTS.map((d) => [d.code, d.name]));

  const csv = [
    'employee_code,email,role,password,full_name,department',
    ...allPeople.map((person) =>
      [
        employeeCodeByUserId.get(userIdByEmail.get(person.email)!)!,
        person.email,
        person.role,
        person.password,
        `${person.firstName} ${person.lastName}`,
        departmentNameByCode.get(person.departmentCode)!,
      ]
        .map(csvField)
        .join(','),
    ),
  ].join('\n');

  await mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true });
  await writeFile(CREDENTIALS_FILE, `${csv}\n`, 'utf8');

  console.log(
    `\nSeed complete: ${allPeople.length} accounts, ${activeEmployees.length} active and ${terminated.length} former.`,
  );
  console.log('\nDemo accounts (the three documented in the README):');
  console.table(
    demoPeople.map((person) => ({ role: person.role, email: person.email, password: person.password })),
  );
  console.log(
    `Every other account has its own password. All ${allPeople.length} are listed in:\n` +
      `  ${CREDENTIALS_FILE}\n` +
      '  (git-ignored — hand it to whoever runs the system; do not commit it)',
  );
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

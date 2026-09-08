export type Role = 'ADMIN' | 'HR' | 'EMPLOYEE';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  employeeId: string | null;
}

export interface Employee {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  address: string | null;
  hireDate: string;
  employmentStatus: 'PROBATION' | 'ACTIVE' | 'ON_LEAVE' | 'TERMINATED';
  terminatedAt: string | null;
  isActive: boolean;
  department: { id: string; name: string } | null;
  position: { id: string; title: string; level: string } | null;
  /** Absent — not null — when the viewer is not allowed to see it. */
  baseSalary?: number;
  createdAt: string;
}

export interface Department {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  employeeCount: number;
}

export interface Position {
  id: string;
  title: string;
  level: string;
  description: string | null;
  isActive: boolean;
  employeeCount: number;
}

export interface AttendanceRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  departmentName: string | null;
  workDate: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  status: 'PRESENT' | 'LATE' | 'ON_LEAVE';
  lateMinutes: number;
  earlyLeaveMinutes: number;
  workMinutes: number;
  overtimeMinutes: number;
  note: string | null;
  correctedAt: string | null;
}

export interface AttendanceSummary {
  employeeId: string;
  from: string;
  to: string;
  daysRecorded: number;
  presentDays: number;
  lateDays: number;
  totalLateMinutes: number;
  totalWorkMinutes: number;
  totalOvertimeMinutes: number;
  earlyLeaveDays: number;
}

export interface LeaveType {
  id: string;
  code: string;
  name: string;
  description: string | null;
  defaultDays: number;
  isPaid: boolean;
  isActive: boolean;
}

export interface LeaveBalance {
  id: string;
  leaveTypeId: string;
  leaveTypeName: string;
  leaveTypeCode: string;
  isPaid: boolean;
  year: number;
  entitledDays: number;
  usedDays: number;
  remainingDays: number;
}

export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface LeaveRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  departmentName: string | null;
  leaveTypeId: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason: string;
  status: LeaveStatus;
  decidedByEmail: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface DashboardOverview {
  totalEmployees: number;
  activeEmployees: number;
  newHiresThisMonth: number;
  departmentCount: number;
  presentToday: number;
  lateToday: number;
  onLeaveToday: number;
  notCheckedInToday: number;
  pendingLeaveRequests: number;
  openAttendanceRecords: number;
}

export interface DashboardCharts {
  range: { from: string; to: string };
  headcountByDepartment: {
    departmentId: string | null;
    departmentName: string;
    employeeCount: number;
    averageTenureYears: number;
  }[];
  attendanceTrend: { workDate: string; present: number; late: number; totalRecords: number }[];
  leaveStatistics: {
    leaveTypeName: string;
    requestCount: number;
    approvedDays: number;
    pendingCount: number;
    rejectedCount: number;
  }[];
  employeeGrowth: { month: string; hires: number; leavers: number; headcount: number }[];
}

export interface LateEmployee {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  departmentName: string | null;
  lateDays: number;
  totalLateMinutes: number;
}

export interface AiToolCall {
  name: string;
  allowed: boolean;
  deniedReason?: string;
  durationMs: number;
  error?: string;
}

export interface AiAnswer {
  conversationId: string;
  answer: string;
  toolCalls: AiToolCall[];
  truncated: boolean;
}

export interface AiCapabilities {
  role: Role;
  provider: string;
  tools: { name: string; description: string; scope: 'self' | 'organisation' }[];
}

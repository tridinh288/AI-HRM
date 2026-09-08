import type { Role } from '../db/schema.js';

/**
 * Who is making this request.
 *
 * Built from a verified JWT, never from anything the client can choose. Every
 * authorization decision in the codebase reads from this object — including the
 * AI tool layer, which is why an injected prompt cannot change who the caller is:
 * `employeeId` here comes from the token, not from the model's arguments.
 *
 * `employeeId` is nullable because an ADMIN account is not required to have an
 * HR record. Anything scoped to "my own data" must therefore handle its absence
 * rather than assuming it.
 */
export interface AuthContext {
  userId: string;
  email: string;
  role: Role;
  employeeId: string | null;
}

export function isHrOrAdmin(auth: AuthContext): boolean {
  return auth.role === 'HR' || auth.role === 'ADMIN';
}

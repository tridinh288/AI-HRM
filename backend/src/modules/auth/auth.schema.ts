import { z } from 'zod';

/**
 * Password policy, in one place so registration, admin-created accounts and
 * password changes cannot drift apart.
 *
 * Length is the requirement that actually matters. Composition rules
 * ("one uppercase, one digit, one symbol") push people towards `Password1!`,
 * which is both harder to remember and easier to guess than a long passphrase —
 * which is why NIST stopped recommending them.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters');

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: passwordSchema,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    path: ['newPassword'],
    message: 'New password must be different from the current password',
  });

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

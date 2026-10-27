import bcrypt from 'bcryptjs';
import { User } from '../models/index.js';

/**
 * Create or update the predefined admin from ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD (environment variables).
 * Runs at every start, so those values are the source of truth: changing ADMIN_PASSWORD and restarting changes the login.
 */
export async function ensurePredefinedAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email && !password) return null; // not configured: nothing to do
  if (!email || password.length < 10) {
    console.error('[admin] Set both ADMIN_EMAIL and ADMIN_PASSWORD (password at least 10 characters) to create the predefined admin.');
    return null;
  }
  const name = (process.env.ADMIN_NAME || 'Admin').trim();
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.findOneAndUpdate({ email }, { email, name, role: 'admin', passwordHash, active: true }, { upsert: true, new: true });
  console.log(`[admin] predefined admin ready: ${user.email}`);
  return user;
}

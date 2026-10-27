// Usage: npm run create-admin -- admin@company.com "Admin Name" 'a-long-password'
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { User } from '../models/index.js';

const [email, name, password] = process.argv.slice(2);
if (!email || !name || !password || password.length < 10) {
  console.error('Usage: npm run create-admin -- <email> "<name>" <password (min 10 chars)>');
  process.exit(1);
}
await mongoose.connect(config.mongoUri);
const passwordHash = await bcrypt.hash(password, 12);
const user = await User.findOneAndUpdate({ email: email.toLowerCase() }, { email: email.toLowerCase(), name, role: 'admin', passwordHash, active: true }, { upsert: true, new: true });
console.log(`Admin ready: ${user.email}`);
await mongoose.disconnect();

import { useState, type FormEvent } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { errMsg } from '../lib/api';
import { Alert } from '../components/ui';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try { await login(email, password); } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  };
  return (
    <div className="grid min-h-screen place-items-center bg-canvas bg-[radial-gradient(ellipse_at_top,rgba(79,140,255,0.18),transparent_60%)] px-4">
      <form onSubmit={submit} className="card fade-in w-full max-w-sm p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-accent"><FileSpreadsheet className="h-5 w-5 text-white" /></div>
          <div>
            <div className="font-bold text-ink">Tata Dialer</div>
            <div className="text-xs text-slate-500">CDR Report Automation</div>
          </div>
        </div>
        <div className="space-y-4">
          <div><label className="label" htmlFor="email">Email</label><input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div><label className="label" htmlFor="pw">Password</label><input id="pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          {error && <Alert kind="error">{error}</Alert>}
          <button className="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </div>
      </form>
    </div>
  );
}

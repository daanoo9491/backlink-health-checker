import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { RequestError } from '../api/client';
import { Icon } from '../components/Icon';

export function LoginPage() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showReset, setShowReset] = useState(false);

  useEffect(() => {
    document.title = 'Sign in · Backlink Health Checker';
  }, []);

  if (user) return <Navigate to={from} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof RequestError ? err.message : 'Sign-in failed. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login">
      <div className="login-intro">
        <span className="brand-mark brand-mark-large">
          <Icon name="link" size={28} />
        </span>
        <h1 className="login-title">Backlink Health Checker</h1>
        <p className="login-lead">
          Upload your backlink sheet. We open every link for you and tell you which ones still work.
        </p>
      </div>

      <form className="login-card" onSubmit={onSubmit} noValidate>
        <h2 className="login-card-title">Sign in</h2>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <button type="submit" className="button button-primary button-block" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>

        <button type="button" className="link-button" onClick={() => setShowReset((s) => !s)} aria-expanded={showReset}>
          Forgot password?
        </button>
        {showReset && (
          <p className="form-hint">Ask your administrator to reset your password. Self-service reset is coming soon.</p>
        )}
      </form>
    </div>
  );
}

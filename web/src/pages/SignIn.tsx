import { useState } from 'react';
import { APP_NAME } from '../lib/db';
import { useAuth } from '../lib/auth';
import { ErrorNote, Logo } from '../lib/ui';

export default function SignIn() {
  const { signInWithGoogle } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try { await signInWithGoogle(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <div className="signin">
      <section className="signin-art">
        <div className="row" style={{ fontWeight: 700 }}><Logo size={72} /> {APP_NAME}</div>
        <div>
          <h1>Practise under real exam conditions.</h1>
          <p>Timed JEE Main and Advanced style papers in Physics, Chemistry and Mathematics, with marking that follows each paper's scheme and solutions for every question.</p>
        </div>
        <svg className="plot" viewBox="0 0 520 260" aria-hidden>
          <path d="M10 240 C 90 238, 130 200, 180 150 S 290 40, 360 60 S 470 170, 510 120" fill="none" stroke="#F5C518" strokeWidth="3" />
          <circle cx="360" cy="60" r="6" fill="#F5C518" />
          <text x="372" y="50" fill="rgba(255,255,255,0.85)" fontFamily="Literata, serif" fontSize="18" fontStyle="italic">f′(x) = 0</text>
        </svg>
        <p className="small" style={{ margin: 0 }}>Independent practice platform. Not affiliated with NTA or the IITs.</p>
      </section>
      <section className="signin-form">
        <div>
          <h2 style={{ fontSize: '1.5rem' }}>Sign in</h2>
          <p className="muted">Use your Google account. Your attempts and scores are private to you.</p>
        </div>
        <button className="google-btn" onClick={go} disabled={busy}>
          <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
          {busy ? 'Opening Google…' : 'Continue with Google'}
        </button>
        <ErrorNote error={error} />
      </section>
    </div>
  );
}

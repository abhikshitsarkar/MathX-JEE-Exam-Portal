import { lazy, Suspense, useEffect } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { APP_NAME, isConfigured } from './lib/db';
import { Loading, Logo, useTheme } from './lib/ui';
import SignIn from './pages/SignIn';
import SetupRequired from './pages/SetupRequired';
import StudentDashboard from './pages/student/Dashboard';

const ExamStart = lazy(() => import('./pages/student/ExamStart'));
const ExamRoom = lazy(() => import('./pages/student/ExamRoom'));
const Submitted = lazy(() => import('./pages/student/Submitted'));
const Result = lazy(() => import('./pages/student/Result'));
const History = lazy(() => import('./pages/student/History'));
const PracticeBuild = lazy(() => import('./pages/student/PracticeBuild'));
const AdminOverview = lazy(() => import('./pages/admin/Overview'));
const AdminQuestions = lazy(() => import('./pages/admin/Questions'));
const QuestionEditor = lazy(() => import('./pages/admin/QuestionEditor'));
const AdminExams = lazy(() => import('./pages/admin/Exams'));
const ExamEditor = lazy(() => import('./pages/admin/ExamEditor'));
const ExamReport = lazy(() => import('./pages/admin/ExamReport'));
const Generate = lazy(() => import('./pages/admin/Generate'));
const GenerationJob = lazy(() => import('./pages/admin/GenerationJob'));
const Documents = lazy(() => import('./pages/admin/Documents'));
const Users = lazy(() => import('./pages/admin/Users'));
const Settings = lazy(() => import('./pages/admin/Settings'));
const Logs = lazy(() => import('./pages/admin/Logs'));

function TopBar() {
  const { profile, isAdmin, signOut } = useAuth();
  const { theme, cycle } = useTheme();
  const loc = useLocation();
  const inAdmin = loc.pathname.startsWith('/admin');
  return (
    <header className="topbar">
      <div className="topbar-inner" style={inAdmin ? { maxWidth: 'none' } : undefined}>
        <NavLink to="/" className="brand"><Logo /> <span>{APP_NAME}</span></NavLink>
        <nav className="topnav" aria-label="Main">
          <NavLink to="/" end>Tests</NavLink>
          <NavLink to="/history">My attempts</NavLink>
          <NavLink to="/make">Make a paper</NavLink>
          <NavLink to="/material">Study material</NavLink>
          {isAdmin && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <button className="icon-btn" onClick={cycle} title="Change theme" aria-label={`Theme: ${theme}`}>
          {theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'Auto'}
        </button>
        <div className="user-chip">
          {profile?.avatar_url ? <img src={profile.avatar_url} alt="" referrerPolicy="no-referrer" /> : null}
          <button className="icon-btn" onClick={() => void signOut()}>Sign out</button>
        </div>
      </div>
    </header>
  );
}

function Shell() {
  return (<><TopBar /><Suspense fallback={<Loading />}><Outlet /></Suspense></>);
}

function AdminShell() {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/" replace />;
  const links: [string, string, boolean?][] = [
    ['/admin', 'Overview', true], ['/admin/exams', 'Exams'], ['/admin/generate', 'Generate with AI'],
    ['/admin/questions', 'Question bank'], ['/admin/documents', 'Study material'], ['/admin/users', 'Students & admins'],
    ['/admin/settings', 'Settings'], ['/admin/logs', 'Logs'],
  ];
  return (
    <div className="admin-layout">
      <nav className="sidenav" aria-label="Admin">
        <h4>Administration</h4>
        {links.map(([to, label, end]) => <NavLink key={to} to={to} end={end}>{label}</NavLink>)}
      </nav>
      <main className="admin-main"><Suspense fallback={<Loading />}><Outlet /></Suspense></main>
    </div>
  );
}

export default function App() {
  const { loading, session, profile, error, signOut } = useAuth();
  useEffect(() => { document.title = APP_NAME; }, []);

  if (!isConfigured) return <SetupRequired />;
  if (loading) return <Loading label="Starting…" />;
  if (!session) return <SignIn />;
  if (!profile && error) {
    return (
      <div className="page" style={{ maxWidth: 640 }}>
        <div className="notice bad">Signed in, but your account could not be loaded: {error}</div>
        <p><button className="btn" onClick={() => void signOut()}>Sign out</button></p>
      </div>
    );
  }
  if (!profile) return <Loading label="Loading your account…" />;
  if (profile?.is_blocked) {
    return <div className="page"><div className="notice bad">Your account has been suspended. Contact your administrator.</div></div>;
  }

  return (
    <Routes>
      <Route path="/attempt/:attemptId" element={<Suspense fallback={<Loading />}><ExamRoom /></Suspense>} />
      <Route element={<Shell />}>
        <Route index element={<StudentDashboard />} />
        <Route path="exam/:versionId" element={<ExamStart />} />
        <Route path="attempt/:attemptId/submitted" element={<Submitted />} />
        <Route path="result/:attemptId" element={<Result />} />
        <Route path="history" element={<History />} />
        <Route path="make" element={<Generate practice />} />
        <Route path="make/:jobId" element={<PracticeBuild />} />
        <Route path="material" element={<div className="page"><Documents shared /></div>} />
        <Route path="admin" element={<AdminShell />}>
          <Route index element={<AdminOverview />} />
          <Route path="questions" element={<AdminQuestions />} />
          <Route path="questions/new" element={<QuestionEditor />} />
          <Route path="questions/:id" element={<QuestionEditor />} />
          <Route path="exams" element={<AdminExams />} />
          <Route path="exams/:examId" element={<ExamEditor />} />
          <Route path="reports/:versionId" element={<ExamReport />} />
          <Route path="generate" element={<Generate />} />
          <Route path="generate/:jobId" element={<GenerationJob />} />
          <Route path="documents" element={<Documents />} />
          <Route path="users" element={<Users />} />
          <Route path="settings" element={<Settings />} />
          <Route path="logs" element={<Logs />} />
        </Route>
        <Route path="*" element={<div className="page"><h1>Page not found</h1><p><NavLink to="/">Go to your tests</NavLink></p></div>} />
      </Route>
    </Routes>
  );
}

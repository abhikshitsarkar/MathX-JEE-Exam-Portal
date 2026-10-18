import { useState } from 'react';
import { rpc } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/format';
import { Confirm, ErrorNote, Loading, Pager, useAsync, useToast } from '../../lib/ui';

interface U { id: string; email: string; full_name: string | null; avatar_url: string | null; is_blocked: boolean; created_at: string; roles: string[]; attempts: number }
const LIMIT = 50;

export default function Users() {
  const toast = useToast();
  const { session } = useAuth();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<{ user: U; action: 'grant' | 'revoke' | 'block' | 'unblock' } | null>(null);
  const list = useAsync(() => rpc<{ total: number; items: U[] }>('admin_list_users', { p_search: search || null, p_limit: LIMIT, p_offset: offset }), [search, offset]);

  const run = async () => {
    if (!pending) return;
    const { user, action } = pending;
    try {
      if (action === 'grant' || action === 'revoke') await rpc('admin_set_role', { p_user: user.id, p_role: 'admin', p_grant: action === 'grant' });
      else await rpc('admin_set_blocked', { p_user: user.id, p_blocked: action === 'block' });
      toast('Updated');
      list.reload();
    } catch (e) { toast((e as Error).message, true); }
    setPending(null);
  };

  return (
    <div className="stack">
      <div className="page-head"><div><h1>Students &amp; admins</h1><p>Everyone who has signed in with Google. Admin rights are granted here and checked on the server.</p></div></div>
      <input type="search" placeholder="Search by name or email" aria-label="Search users" style={{ maxWidth: 360 }}
        onKeyDown={(e) => { if (e.key === 'Enter') { setOffset(0); setSearch((e.target as HTMLInputElement).value.trim()); } }} />
      <ErrorNote error={list.error} onRetry={list.reload} />
      {list.loading && !list.data ? <Loading /> : list.data && (
        <div className="panel flush">
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Person</th><th>Role</th><th>Attempts</th><th>Joined</th><th /></tr></thead>
            <tbody>{list.data.items.map((u) => {
              const admin = u.roles.includes('admin');
              const me = u.id === session?.user.id;
              return (
                <tr key={u.id}>
                  <td><div className="row" style={{ gap: '0.6rem', flexWrap: 'nowrap' }}>
                    {u.avatar_url ? <img className="avatar" src={u.avatar_url} alt="" referrerPolicy="no-referrer" /> : <span className="avatar" />}
                    <div>{u.full_name || '—'}{me && <span className="muted small"> (you)</span>}<div className="small muted">{u.email}</div></div></div></td>
                  <td>{admin ? <span className="badge brand">Admin</span> : <span className="badge">Student</span>} {u.is_blocked && <span className="badge bad">Blocked</span>}</td>
                  <td className="num">{u.attempts}</td>
                  <td className="small num">{fmtDate(u.created_at, false)}</td>
                  <td><div className="btn-row" style={{ flexWrap: 'nowrap' }}>
                    {admin ? <button className="btn sm" onClick={() => setPending({ user: u, action: 'revoke' })}>Remove admin</button>
                      : <button className="btn sm" onClick={() => setPending({ user: u, action: 'grant' })}>Make admin</button>}
                    {!me && (u.is_blocked ? <button className="btn sm" onClick={() => setPending({ user: u, action: 'unblock' })}>Unblock</button>
                      : <button className="btn sm danger" onClick={() => setPending({ user: u, action: 'block' })}>Block</button>)}
                  </div></td>
                </tr>
              );
            })}</tbody>
          </table></div>
          <div style={{ padding: '0 1rem 1rem' }}><Pager total={list.data.total} limit={LIMIT} offset={offset} onChange={setOffset} /></div>
        </div>
      )}
      {pending && (
        <Confirm title={{ grant: 'Make this person an admin?', revoke: 'Remove admin rights?', block: 'Block this person?', unblock: 'Unblock this person?' }[pending.action]}
          danger={pending.action === 'block' || pending.action === 'grant'} confirmLabel={{ grant: 'Make admin', revoke: 'Remove admin', block: 'Block', unblock: 'Unblock' }[pending.action]}
          onClose={() => setPending(null)} onConfirm={() => void run()}
          body={<p>{{ grant: `${pending.user.email} will be able to see every question, answer key and student result, and change everything.`,
            revoke: `${pending.user.email} will keep their student account.`, block: `${pending.user.email} will not be able to use the portal. Their records are kept.`,
            unblock: `${pending.user.email} will be able to sign in and take tests again.` }[pending.action]}</p>} />
      )}
    </div>
  );
}

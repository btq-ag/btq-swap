import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { User, PaginatedResponse } from '../../types';

export function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const limit = 25;

  useEffect(() => {
    setLoading(true);
    api
      .get<PaginatedResponse<User>>(`/admin/users?page=${page}&limit=${limit}`)
      .then((res) => {
        setUsers(res.data);
        setTotal(res.total);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page]);

  const toggleBan = async (userId: string, banned: boolean) => {
    try {
      await api.put(`/admin/users/${userId}`, { banned: !banned });
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, banned: !banned } : u))
      );
    } catch (err) {
      console.error('Failed to update user:', err);
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Users</h1>
        <span className="text-sm text-slate-400">{total} total</span>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-800/50" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-700/50">
          <table className="w-full min-w-[700px]">
            <thead>
              <tr className="bg-slate-800/80">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">Address</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">Role</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">Swaps</th>
                <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-slate-400">Status</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">Joined</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {users.map((user) => (
                <tr key={user.id} className="bg-slate-800/30 transition-colors hover:bg-slate-800/60">
                  <td className="px-4 py-3 font-mono text-sm text-white">
                    {user.address.slice(0, 6)}…{user.address.slice(-4)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        user.role === 'admin'
                          ? 'bg-amber-500/20 text-amber-400'
                          : 'bg-slate-500/20 text-slate-400'
                      }`}
                    >
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-sm text-white">
                    {user.swapCount}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        user.banned
                          ? 'bg-red-500/20 text-red-400'
                          : 'bg-emerald-500/20 text-emerald-400'
                      }`}
                    >
                      {user.banned ? 'Banned' : 'Active'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-slate-400">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {user.role !== 'admin' && (
                      <button
                        onClick={() => toggleBan(user.id, user.banned)}
                        className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                          user.banned
                            ? 'bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30'
                            : 'bg-red-600/20 text-red-400 hover:bg-red-600/30'
                        }`}
                      >
                        {user.banned ? 'Unban' : 'Ban'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-400">Page {page} of {totalPages}</p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700 disabled:cursor-not-allowed disabled:text-slate-600"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700 disabled:cursor-not-allowed disabled:text-slate-600"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

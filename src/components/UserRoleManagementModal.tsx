import { useEffect, useState } from 'react';
import { X, Shield, UserCog, Check } from 'lucide-react';
import type { UserProfile, UserRole } from '../types/tax';
import { getAllUserProfiles, updateUserRole } from '../lib/taxService';
import { logActivity } from '../lib/auditService';

interface UserRoleManagementModalProps {
  currentUid: string;
  onClose: () => void;
}

export function UserRoleManagementModal({
  currentUid,
  onClose,
}: UserRoleManagementModalProps) {
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingUid, setUpdatingUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadProfiles();
  }, []);

  const loadProfiles = async () => {
    setLoading(true);
    try {
      const list = await getAllUserProfiles();
      setProfiles(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load user profiles.');
    } finally {
      setLoading(false);
    }
  };

  const handleRoleChange = async (uid: string, newRole: UserRole) => {
    setUpdatingUid(uid);
    setError(null);
    const targetUser = profiles.find((p) => p.uid === uid);
    const previousRole = targetUser?.role || 'unknown';
    try {
      await updateUserRole(uid, newRole);
      setProfiles((prev) =>
        prev.map((p) => (p.uid === uid ? { ...p, role: newRole } : p))
      );
      void logActivity({
        pageVisited: 'User & Role Management',
        actionTaken: 'UPDATE_USER_ROLE',
        details: `Updated role for ${targetUser?.email || uid} (${targetUser?.displayName || 'User'}) from "${previousRole}" to "${newRole}".`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role.');
    } finally {
      setUpdatingUid(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rbac-modal-title"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <UserCog className="w-5 h-5 text-teal-700" />
            <h2 id="rbac-modal-title" className="text-base font-semibold text-slate-900">
              User &amp; Role Management (RBAC)
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <p className="text-xs text-slate-600 leading-relaxed">
            Manage permissions across registered accounts. <span className="font-semibold text-slate-900">Administrator</span> has full access and role management; <span className="font-semibold text-slate-900">Manager</span> can assign duties and run operations; <span className="font-semibold text-slate-900">User</span> can only view their own tax dossier.
          </p>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
              {error}
            </div>
          )}

          {loading ? (
            <div className="py-12 text-center text-sm text-slate-500">
              Loading registered user accounts...
            </div>
          ) : profiles.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-500">
              No registered user accounts found in Firestore.
            </div>
          ) : (
            <div className="border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-xs font-medium text-slate-500">
                    <th className="py-3 px-4">User</th>
                    <th className="py-3 px-4">Email</th>
                    <th className="py-3 px-4">Role Assignment</th>
                    <th className="py-3 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {profiles.map((p) => {
                    const isSelf = p.uid === currentUid;
                    const isUpdating = updatingUid === p.uid;

                    return (
                      <tr key={p.uid} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-3 px-4 font-medium text-slate-900">
                          <div className="flex items-center gap-2">
                            <span>{p.displayName}</span>
                            {isSelf && (
                              <span className="text-[10px] bg-teal-50 text-teal-700 px-1.5 py-0.5 rounded font-mono font-medium">
                                You
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="py-3 px-4 text-xs font-mono text-slate-600">
                          {p.email}
                        </td>

                        <td className="py-3 px-4">
                          <select
                            value={p.role}
                            disabled={isSelf || isUpdating}
                            onChange={(e) =>
                              handleRoleChange(p.uid, e.target.value as UserRole)
                            }
                            className="px-2.5 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700 cursor-pointer"
                          >
                            <option value="administrator">administrator</option>
                            <option value="manager">manager</option>
                            <option value="user">user</option>
                          </select>
                        </td>

                        <td className="py-3 px-4 text-right text-xs">
                          {isSelf ? (
                            <span className="text-slate-400 italic">Cannot change own role</span>
                          ) : isUpdating ? (
                            <span className="text-teal-700 font-medium">Updating...</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                              <Check className="w-3.5 h-3.5" />
                              <span>Active</span>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { X, UserCog, Check, ShieldAlert } from 'lucide-react';
import type { UserProfile, UserRole } from '../types/tax';
import { getAllUserProfiles, updateUserRole } from '../lib/taxService';
import { submitGovernanceChangeRequest } from '../lib/governanceService';
import { logActivity } from '../lib/auditService';
import { GovernanceReasonModal } from './GovernanceReasonModal';

interface UserRoleManagementModalProps {
  currentUid: string;
  currentUserRole: UserRole;
  onClose: () => void;
  onGovernanceSubmitted: (message: string) => void;
}

export function UserRoleManagementModal({
  currentUid,
  currentUserRole,
  onClose,
  onGovernanceSubmitted,
}: UserRoleManagementModalProps) {
  const isAdmin = currentUserRole === 'administrator';

  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingUid, setUpdatingUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRoleChange, setPendingRoleChange] = useState<{
    target: UserProfile;
    newRole: UserRole;
    mode: 'admin-confirm' | 'stage-elevation';
  } | null>(null);

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

  const executeAdminRoleUpdate = async (
    targetUser: UserProfile,
    newRole: UserRole,
    reasonNote?: string
  ) => {
    setUpdatingUid(targetUser.uid);
    setError(null);
    const previousRole = targetUser.role;
    try {
      await updateUserRole(targetUser.uid, newRole);
      setProfiles((prev) =>
        prev.map((p) => (p.uid === targetUser.uid ? { ...p, role: newRole } : p))
      );
      void logActivity({
        pageVisited: 'User & Role Management',
        actionTaken: 'UPDATE_USER_ROLE',
        details: `Updated role for ${targetUser.email} (${targetUser.displayName}) from "${previousRole}" to "${newRole}".${reasonNote ? ` Justification: ${reasonNote}` : ''}`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role.');
    } finally {
      setUpdatingUid(null);
    }
  };

  const handleRoleSelect = (target: UserProfile, newRole: UserRole) => {
    if (newRole === target.role) return;
    setError(null);

    const isPrivilegedTarget = newRole === 'administrator' || newRole === 'manager';

    if (!isAdmin) {
      // Non-admin (e.g., manager) MUST stage any role change/elevation for System Admin approval
      setPendingRoleChange({
        target,
        newRole,
        mode: 'stage-elevation',
      });
      return;
    }

    if (isPrivilegedTarget) {
      // Administrator assigning administrator or manager requires explicit confirmation modal
      setPendingRoleChange({
        target,
        newRole,
        mode: 'admin-confirm',
      });
      return;
    }

    // Administrator demoting to regular 'user'
    void executeAdminRoleUpdate(target, newRole);
  };

  const handleConfirmPendingRole = async (reason: string) => {
    if (!pendingRoleChange) return;
    const { target, newRole, mode } = pendingRoleChange;

    if (mode === 'admin-confirm') {
      await executeAdminRoleUpdate(target, newRole, reason);
      setPendingRoleChange(null);
      return;
    }

    // Stage ROLE_ELEVATION request in change_requests
    setUpdatingUid(target.uid);
    setError(null);
    try {
      await submitGovernanceChangeRequest({
        category: 'ROLE_ELEVATION',
        targetCollection: 'users',
        targetDocId: target.uid,
        targetLabel: `${target.email} (${target.displayName})`,
        operation: 'UPDATE',
        proposedPayload: { role: newRole },
        previousSummary: `Role: ${target.role} -> ${newRole}`,
        reason,
        requestedByRole: currentUserRole,
        pageVisited: 'User & Role Management',
      });
      setPendingRoleChange(null);
      onGovernanceSubmitted(
        'Submitted to Danger Zone — awaiting System Administrator approval.'
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to submit role elevation request.'
      );
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
            Manage permissions across registered accounts.{' '}
            <span className="font-semibold text-slate-900">Administrator</span> has full access and
            approval authority;{' '}
            <span className="font-semibold text-slate-900">Manager</span> can view dossiers and
            propose changes;{' '}
            <span className="font-semibold text-slate-900">User</span> can only view their own tax
            dossier.
          </p>

          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <span>
              {isAdmin
                ? 'Governance gate active: elevating any account to Administrator or Manager requires explicit System Administrator confirmation and is permanently recorded in the Audit Trail.'
                : 'Non-administrator governance gate active: any role change or privilege elevation is staged as a PENDING ROLE_ELEVATION request in the Danger Zone until approved by a System Administrator.'}
            </span>
          </div>

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
                    <th className="py-3 px-4 text-right">Status</th>
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
                              handleRoleSelect(p, e.target.value as UserRole)
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
                            <span className="text-teal-700 font-medium">Processing...</span>
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

      {pendingRoleChange && (
        <GovernanceReasonModal
          title={
            pendingRoleChange.mode === 'admin-confirm'
              ? `Confirm System Admin Role Elevation (${pendingRoleChange.newRole})`
              : `Submit Role Elevation Request (${pendingRoleChange.newRole})`
          }
          description={
            pendingRoleChange.mode === 'admin-confirm'
              ? `You are about to grant "${pendingRoleChange.newRole}" privileges to ${pendingRoleChange.target.email}. Confirm this privileged role change and record a justification for the immutable audit trail.`
              : `Elevating ${pendingRoleChange.target.email} to "${pendingRoleChange.newRole}" requires System Administrator approval. Submit a justification to stage this ROLE_ELEVATION request in the Danger Zone.`
          }
          targetLabel={`${pendingRoleChange.target.email} (${pendingRoleChange.target.displayName})`}
          previousSummary={`Role: ${pendingRoleChange.target.role} -> ${pendingRoleChange.newRole}`}
          confirmLabel={
            pendingRoleChange.mode === 'admin-confirm'
              ? `Confirm Grant ${pendingRoleChange.newRole}`
              : 'Submit Role Request to Danger Zone'
          }
          requireReason={true}
          minReasonLength={10}
          submitting={updatingUid === pendingRoleChange.target.uid}
          error={error}
          onCancel={() => {
            setPendingRoleChange(null);
            setError(null);
          }}
          onConfirm={handleConfirmPendingRole}
        />
      )}
    </div>
  );
}

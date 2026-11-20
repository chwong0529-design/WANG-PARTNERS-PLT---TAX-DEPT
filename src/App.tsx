import { useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  LayoutGrid,
  BellRing,
  FileCheck2,
  Plus,
  LogOut,
  Menu,
  X,
  FolderOpen,
  UserCog,
  ClipboardList,
} from 'lucide-react';
import { auth, googleProvider } from './lib/firebase';
import {
  determineWorkflowStage,
  initializeUserProfile,
  subscribeToClients,
  getAllUserProfiles,
} from './lib/taxService';
import { logActivity, setAuditUserContext } from './lib/auditService';
import type { TaxClient, UserProfile, UserRole } from './types/tax';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SignInScreen } from './components/SignInScreen';
import { StaffDashboard } from './components/StaffDashboard';
import { ClientDossier } from './components/ClientDossier';
import { ReminderQueueView } from './components/ReminderQueueView';
import { NewClientModal } from './components/NewClientModal';
import { UserRoleManagementModal } from './components/UserRoleManagementModal';
import { AuditTrailView } from './components/AuditTrailView';

type NavSection = 'clients' | 'reminders' | 'client-portal' | 'audit-trail';

function CukaiDeskApp() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [clients, setClients] = useState<TaxClient[]>([]);
  const [staffProfiles, setStaffProfiles] = useState<UserProfile[]>([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [runtimeError, setRuntimeError] = useState<Error | null>(null);

  const [activeNav, setActiveNav] = useState<NavSection>('clients');
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [portalMode, setPortalMode] = useState<'staff' | 'client'>('staff');
  const [highlightedReminderClient, setHighlightedReminderClient] = useState<string | null>(null);
  const [showNewClientModal, setShowNewClientModal] = useState(false);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const userInitiatedSignInRef = useRef(false);
  const lastLoggedPageRef = useRef<string | null>(null);

  if (runtimeError) {
    throw runtimeError;
  }

  const role: UserRole = userProfile?.role || 'user';
  const isAdminOrManager = role === 'administrator' || role === 'manager';

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        try {
          const profile = await initializeUserProfile(firebaseUser);
          setAuditUserContext(profile);
          setUserProfile(profile);
          setPortalMode(profile.role === 'user' ? 'client' : 'staff');
          setActiveNav(profile.role === 'user' ? 'client-portal' : 'clients');

          if (userInitiatedSignInRef.current) {
            userInitiatedSignInRef.current = false;
            void logActivity({
              pageVisited: 'Sign In',
              actionTaken: 'USER_SIGN_IN',
              details: `User signed in via Google Authentication as ${profile.role}.`,
            });
          }
        } catch (err) {
          console.error('Error initializing user profile:', err);
        }
      } else {
        setAuditUserContext(null);
        lastLoggedPageRef.current = null;
        setUserProfile(null);
        setClients([]);
        setSelectedClientId(null);
      }
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!authReady || !user || !user.email) {
      setClientsLoading(false);
      return;
    }
    setClientsLoading(true);
    const unsub = subscribeToClients(
      role,
      user.uid,
      user.email,
      userProfile?.assignedClientId,
      (list) => {
        setClients(list);
        setClientsLoading(false);
      },
      (err) => {
        setClientsLoading(false);
        setRuntimeError(err);
      }
    );
    return () => unsub();
  }, [authReady, user, role, userProfile?.assignedClientId]);

  useEffect(() => {
    if (isAdminOrManager) {
      getAllUserProfiles()
        .then(setStaffProfiles)
        .catch((err) => console.error('Failed to load staff profiles:', err));
    }
  }, [isAdminOrManager]);

  const selectedClient = useMemo(() => {
    if (selectedClientId) {
      return clients.find((c) => c.clientId === selectedClientId) ?? null;
    }
    if (role === 'user') {
      if (userProfile?.assignedClientId) {
        const found = clients.find((c) => c.clientId === userProfile.assignedClientId);
        if (found) return found;
      }
      if (user?.email) {
        const found = clients.find(
          (c) => c.email.toLowerCase() === (user.email || '').toLowerCase()
        );
        if (found) return found;
      }
      return clients[0] ?? null;
    }
    return null;
  }, [clients, selectedClientId, role, userProfile?.assignedClientId, user?.email]);

  const overdueCount = useMemo(
    () => clients.filter((c) => determineWorkflowStage(c).isEscalated).length,
    [clients]
  );

  const currentPageLabel = useMemo(() => {
    if (activeNav === 'audit-trail' && isAdminOrManager) return 'Audit Trail';
    if (activeNav === 'reminders' && isAdminOrManager) return 'Follow-Up Queue';
    if (!isAdminOrManager || activeNav === 'client-portal') {
      return selectedClient
        ? `Client Portal (${selectedClient.clientId})`
        : 'Client Portal';
    }
    if (selectedClient) {
      return portalMode === 'client'
        ? `Client Portal Preview (${selectedClient.clientId})`
        : `Client Dossier (${selectedClient.clientId})`;
    }
    return 'Staff Dashboard';
  }, [activeNav, isAdminOrManager, portalMode, selectedClient]);

  useEffect(() => {
    if (!authReady || !user || !userProfile) return;
    if (lastLoggedPageRef.current === currentPageLabel) return;
    lastLoggedPageRef.current = currentPageLabel;
    void logActivity({
      pageVisited: currentPageLabel,
      actionTaken: 'PAGE_VIEW',
      details: `Viewed ${currentPageLabel}.`,
    });
  }, [authReady, user, userProfile, currentPageLabel]);

  const handleSignIn = async () => {
    setSigningIn(true);
    setAuthError(null);
    userInitiatedSignInRef.current = true;
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      userInitiatedSignInRef.current = false;
      setAuthError(
        err instanceof Error ? err.message : 'Google Sign-In was cancelled or failed.'
      );
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    await logActivity({
      pageVisited: currentPageLabel,
      actionTaken: 'USER_SIGN_OUT',
      details: `Signed out from ${currentPageLabel}.`,
    });
    await signOut(auth);
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-sm text-slate-500">Loading CukaiDesk...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <SignInScreen onSignIn={handleSignIn} signingIn={signingIn} error={authError} />
    );
  }

  const currentBreadcrumb = (() => {
    if (activeNav === 'audit-trail' && isAdminOrManager) {
      return 'Compliance / User Activity & Audit Trail';
    }
    if (!isAdminOrManager || activeNav === 'client-portal') {
      return selectedClient
        ? `Taxpayer Portal / ${selectedClient.clientId}`
        : 'Taxpayer Portal';
    }
    if (activeNav === 'reminders') return 'Operations / Follow-Up Automation';
    if (selectedClient) return `Clients / ${selectedClient.clientId}`;
    return 'Operations / Personal Tax Queue';
  })();

  const handleNavClick = (section: NavSection) => {
    setActiveNav(section);
    setMobileMenuOpen(false);
    setHighlightedReminderClient(null);
    if (section === 'clients') {
      setSelectedClientId(null);
      setPortalMode('staff');
    } else if (section === 'client-portal') {
      setPortalMode('client');
      if (!selectedClientId && clients.length > 0) {
        setSelectedClientId(clients[0].clientId);
      }
    } else {
      setPortalMode('staff');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Sidebar (248px) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-62 shrink-0 bg-white border-r border-slate-200">
        <div className="h-16 px-6 flex items-center border-b border-slate-200">
          <button
            type="button"
            onClick={() => handleNavClick(isAdminOrManager ? 'clients' : 'client-portal')}
            className="text-lg font-bold tracking-tight text-slate-900 font-display whitespace-nowrap cursor-pointer"
          >
            CukaiDesk
          </button>
        </div>

        <nav className="flex-1 p-4 space-y-1" aria-label="Primary workspace navigation">
          {isAdminOrManager ? (
            <>
              <button
                type="button"
                onClick={() => handleNavClick('clients')}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                  activeNav === 'clients'
                    ? 'bg-slate-100 text-slate-900'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <span className="inline-flex items-center gap-2.5">
                  <LayoutGrid className="w-4 h-4 shrink-0" />
                  <span>Client Queue</span>
                </span>
                <span className="font-mono text-xs text-slate-500 tabular-nums">
                  {clients.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleNavClick('reminders')}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                  activeNav === 'reminders'
                    ? 'bg-slate-100 text-slate-900'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <span className="inline-flex items-center gap-2.5">
                  <BellRing className="w-4 h-4 shrink-0" />
                  <span>Follow-Ups</span>
                </span>
                {overdueCount > 0 && (
                  <span className="font-mono text-xs font-semibold text-red-700 tabular-nums">
                    {overdueCount}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => handleNavClick('client-portal')}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                  activeNav === 'client-portal'
                    ? 'bg-slate-100 text-slate-900'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <FileCheck2 className="w-4 h-4 shrink-0" />
                <span>Client Portal Preview</span>
              </button>

              <button
                type="button"
                onClick={() => handleNavClick('audit-trail')}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                  activeNav === 'audit-trail'
                    ? 'bg-slate-100 text-slate-900'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <ClipboardList className="w-4 h-4 shrink-0" />
                <span>Audit Trail</span>
              </button>

              {role === 'administrator' && (
                <button
                  type="button"
                  onClick={() => setShowRoleModal(true)}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium text-slate-600 rounded-lg hover:bg-slate-50 hover:text-slate-900 transition-colors whitespace-nowrap cursor-pointer"
                >
                  <UserCog className="w-4 h-4 shrink-0" />
                  <span>Manage Roles</span>
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => handleNavClick('client-portal')}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-lg bg-slate-100 text-slate-900 whitespace-nowrap cursor-pointer"
            >
              <FileCheck2 className="w-4 h-4 shrink-0" />
              <span>My Tax Checklist</span>
            </button>
          )}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-900 truncate">
              {userProfile?.displayName || user.displayName || 'Authenticated User'}
            </p>
            <p className="text-xs text-slate-500 truncate">{user.email}</p>
            <p className="text-xs text-teal-700 mt-0.5 capitalize">
              Role: {role}
            </p>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative w-64 max-w-[80vw] bg-white h-full flex flex-col border-r border-slate-200 z-10">
            <div className="h-14 px-5 flex items-center justify-between border-b border-slate-200">
              <span className="text-base font-bold text-slate-900 font-display">CukaiDesk</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900"
                aria-label="Close navigation"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 p-3 space-y-1">
              {isAdminOrManager ? (
                <>
                  <button
                    type="button"
                    onClick={() => handleNavClick('clients')}
                    className="w-full text-left px-3 py-2.5 text-sm font-medium text-slate-700 rounded-lg hover:bg-slate-100"
                  >
                    Client Queue ({clients.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => handleNavClick('reminders')}
                    className="w-full text-left px-3 py-2.5 text-sm font-medium text-slate-700 rounded-lg hover:bg-slate-100"
                  >
                    Follow-Ups
                  </button>
                  <button
                    type="button"
                    onClick={() => handleNavClick('client-portal')}
                    className="w-full text-left px-3 py-2.5 text-sm font-medium text-slate-700 rounded-lg hover:bg-slate-100"
                  >
                    Client Portal Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => handleNavClick('audit-trail')}
                    className="w-full text-left px-3 py-2.5 text-sm font-medium text-slate-700 rounded-lg hover:bg-slate-100"
                  >
                    Audit Trail
                  </button>
                  {role === 'administrator' && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowRoleModal(true);
                        setMobileMenuOpen(false);
                      }}
                      className="w-full text-left px-3 py-2.5 text-sm font-medium text-slate-700 rounded-lg hover:bg-slate-100"
                    >
                      Manage Roles
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => handleNavClick('client-portal')}
                  className="w-full text-left px-3 py-2.5 text-sm font-medium text-slate-900 bg-slate-100 rounded-lg"
                >
                  My Tax Checklist
                </button>
              )}
            </div>
            <div className="p-4 border-t border-slate-200">
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full px-3 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg"
              >
                Sign Out ({user.email})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract */}
        <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-6 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <span className="text-sm font-medium text-slate-700 truncate">
              {currentBreadcrumb}
            </span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {isAdminOrManager && activeNav === 'client-portal' && clients.length > 0 && (
              <select
                value={selectedClient?.clientId || ''}
                onChange={(e) => setSelectedClientId(e.target.value)}
                aria-label="Select client for portal preview"
                className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
              >
                {clients.map((c) => (
                  <option key={c.clientId} value={c.clientId}>
                    {c.clientId} — {c.name}
                  </option>
                ))}
              </select>
            )}

            {role === 'administrator' && (
              <button
                type="button"
                onClick={() => setShowRoleModal(true)}
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <UserCog className="w-3.5 h-3.5" />
                <span>Manage Roles</span>
              </button>
            )}

            {role === 'administrator' && (
              <button
                type="button"
                onClick={() => setShowNewClientModal(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>+ New Client</span>
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 p-6 max-w-[1440px] w-full mx-auto">
          {activeNav === 'audit-trail' && isAdminOrManager ? (
            <AuditTrailView userRole={role} />
          ) : activeNav === 'reminders' && isAdminOrManager ? (
            <ReminderQueueView
              clients={clients}
              highlightedClientId={highlightedReminderClient}
              onSelectClient={(id) => {
                setSelectedClientId(id);
                setPortalMode('staff');
                setActiveNav('clients');
              }}
            />
          ) : activeNav === 'client-portal' || role === 'user' ? (
            clientsLoading ? (
              <div className="bg-white border border-slate-200 rounded-xl p-10 text-sm text-slate-500">
                Loading your personal tax portal...
              </div>
            ) : selectedClient ? (
              <ClientDossier
                client={selectedClient}
                userRole={role}
                staffProfiles={staffProfiles}
                portalMode="client"
                userEmail={user.email || ''}
                onTogglePortalPreview={
                  isAdminOrManager
                    ? () => {
                        setPortalMode('staff');
                        setActiveNav('clients');
                      }
                    : undefined
                }
              />
            ) : (
              <div className="bg-white border border-slate-200 rounded-xl p-12 text-center max-w-lg mx-auto my-12">
                <FolderOpen className="w-8 h-8 text-slate-400 mx-auto mb-3" />
                <h2 className="text-base font-semibold text-slate-900">
                  Your account is registered
                </h2>
                <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">
                  Please wait for Wang Partners PLT to link your tax profile.
                </p>
              </div>
            )
          ) : selectedClient ? (
            <ClientDossier
              client={selectedClient}
              userRole={role}
              staffProfiles={staffProfiles}
              portalMode={portalMode}
              userEmail={user.email || ''}
              onBack={() => setSelectedClientId(null)}
              onTogglePortalPreview={() => {
                setPortalMode((m) => (m === 'staff' ? 'client' : 'staff'));
              }}
              onDeleted={() => setSelectedClientId(null)}
            />
          ) : (
            <StaffDashboard
              clients={clients}
              loading={clientsLoading}
              userRole={role}
              staffProfiles={staffProfiles}
              onSelectClient={(id) => {
                setSelectedClientId(id);
                setPortalMode('staff');
              }}
              onOpenNewClient={() => setShowNewClientModal(true)}
              onGoToReminders={(clientId) => {
                setHighlightedReminderClient(clientId ?? null);
                setActiveNav('reminders');
              }}
            />
          )}
        </main>
      </div>

      {showNewClientModal && (
        <NewClientModal
          defaultEmail={isAdminOrManager ? '' : user.email || ''}
          defaultName={isAdminOrManager ? '' : user.displayName || ''}
          lockEmailToUser={!isAdminOrManager}
          existingIds={clients.map((c) => c.clientId)}
          onClose={() => setShowNewClientModal(false)}
          onCreated={(createdId) => {
            setShowNewClientModal(false);
            setSelectedClientId(createdId);
            if (!isAdminOrManager) {
              setActiveNav('client-portal');
            }
          }}
        />
      )}

      {showRoleModal && role === 'administrator' && (
        <UserRoleManagementModal
          currentUid={user.uid}
          onClose={() => setShowRoleModal(false)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <CukaiDeskApp />
    </ErrorBoundary>
  );
}

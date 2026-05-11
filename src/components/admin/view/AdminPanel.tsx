import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/context/AuthContext';
import { Button } from '../../../shared/view/ui';
import { Users, PanelLeftClose, PanelLeft, LogOut, ArrowLeft, Settings, Shield } from 'lucide-react';
import UserManagement from './UserManagement';
import UISettingsPanel from './UISettingsPanel';
import AuthSettingsPanel from './AuthSettingsPanel';

type TabType = 'users' | 'ui-settings' | 'auth-settings';

export default function AdminPanel() {
  const { t } = useTranslation('admin');
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('users');

  const tabs: { id: TabType; icon: React.ReactNode; label: string }[] = [
    { id: 'users', icon: <Users className="h-4 w-4" />, label: t('users.title') },
    { id: 'auth-settings', icon: <Shield className="h-4 w-4" />, label: t('auth.title') },
    { id: 'ui-settings', icon: <Settings className="h-4 w-4" />, label: t('uiSettings.title') },
  ];

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside
        className={`flex flex-col border-r bg-card transition-all duration-200 ${
          sidebarCollapsed ? 'w-16' : 'w-64'
        }`}
      >
        <div className="flex h-14 items-center justify-between border-b px-4">
          {!sidebarCollapsed && (
            <span className="font-semibold">{t('title')}</span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            {sidebarCollapsed ? (
              <PanelLeft className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </Button>
        </div>

        <nav className="flex-1 space-y-1 p-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {tab.icon}
              {!sidebarCollapsed && <span>{tab.label}</span>}
            </button>
          ))}
        </nav>

        <div className="border-t p-2 space-y-1">
          <Button
            variant="ghost"
            className={`w-full justify-start ${sidebarCollapsed ? 'justify-center px-2' : ''}`}
            onClick={() => navigate('/')}
          >
            <ArrowLeft className="h-4 w-4" />
            {!sidebarCollapsed && <span className="ml-2">{t('sidebar.backToFrontend')}</span>}
          </Button>

          {!sidebarCollapsed && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t('sidebar.loggedInAs')} <strong>{user?.username}</strong>
              <br />
              <span className="text-primary">{user?.role === 'admin' ? t('users.admin') : t('users.user')}</span>
            </div>
          )}
          <Button
            variant="ghost"
            className={`w-full justify-start ${sidebarCollapsed ? 'justify-center px-2' : ''}`}
            onClick={logout}
          >
            <LogOut className="h-4 w-4" />
            {!sidebarCollapsed && <span className="ml-2">{t('sidebar.logout')}</span>}
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto p-6">
        {activeTab === 'users' && <UserManagement />}
        {activeTab === 'auth-settings' && <AuthSettingsPanel />}
        {activeTab === 'ui-settings' && <UISettingsPanel />}
      </main>
    </div>
  );
}
import type { ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';
import { useUIConfig } from '../../../contexts/UIConfigContext';

type AuthScreenLayoutProps = {
  title: string;
  description: string;
  children: ReactNode;
  footerText: string;
  logo?: ReactNode;
};

export default function AuthScreenLayout({
  title,
  description,
  children,
  footerText,
  logo,
}: AuthScreenLayoutProps) {
  const { config: uiConfig } = useUIConfig();

  return (
    <div className="login-page-bg flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="space-y-6 rounded-lg border border-border/50 bg-white/90 p-8 shadow-2xl backdrop-blur-sm">
          <div className="text-center">
            <div className="mb-4 flex justify-center">
              {logo ?? (
                <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-primary shadow-sm overflow-hidden">
                  {uiConfig.logoUrl ? (
                    <img src={uiConfig.logoUrl} alt="Logo" className="h-full w-full object-contain" />
                  ) : (
                    <MessageSquare className="h-8 w-8 text-primary-foreground" />
                  )}
                </div>
              )}
            </div>
            <h1 className="text-2xl font-bold text-foreground">{title}</h1>
            <p className="mt-2 text-muted-foreground">{description}</p>
          </div>

          {children}

          <div className="text-center">
            <p className="text-sm text-muted-foreground">{footerText}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

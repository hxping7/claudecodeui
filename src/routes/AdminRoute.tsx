import { Navigate } from 'react-router-dom';
import { useAuth } from '../components/auth/context/AuthContext';

type AdminRouteProps = {
  children: React.ReactNode;
};

export default function AdminRoute({ children }: AdminRouteProps) {
  const { user, isAdmin, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
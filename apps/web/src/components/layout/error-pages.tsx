import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { Lock, SearchX, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api/client';

function Shell({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-muted-foreground">{icon}</div>
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <p className="max-w-md text-muted-foreground">{description}</p>
      <div className="mt-2 flex gap-2">{children}</div>
    </div>
  );
}

export function ForbiddenPage() {
  return (
    <Shell icon={<Lock className="size-8" aria-hidden />} title="Sin permiso" description="Tu rol no permite ver esta sección. Si la necesitas, pide acceso a un administrador.">
      <Button asChild variant="outline">
        <Link to="/">Volver al inicio</Link>
      </Button>
    </Shell>
  );
}

export function NotFoundPage() {
  return (
    <Shell icon={<SearchX className="size-8" aria-hidden />} title="Página no encontrada" description="La dirección no existe o el recurso ya no está disponible.">
      <Button asChild variant="outline">
        <Link to="/">Volver al inicio</Link>
      </Button>
    </Shell>
  );
}

export function RouteErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <Shell icon={<TriangleAlert className="size-8 text-failed" aria-hidden />} title="Algo salió mal" description={errorMessage(error)}>
      <Button
        variant="outline"
        onClick={() => {
          reset();
          void router.invalidate();
        }}
      >
        Reintentar
      </Button>
      <Button asChild variant="ghost">
        <Link to="/">Ir al inicio</Link>
      </Button>
    </Shell>
  );
}

/**
 * 01 · Ingreso (RF-USR-01). Correo + contraseña con TanStack Form + Zod (LoginRequestSchema compartido);
 * botón SSO solo si `/auth/providers` lo anuncia (ESP §12). Error genérico sin revelar existencia de cuenta.
 */
import { useState } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from '@tanstack/react-form';
import { z } from 'zod';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { BrandLogo } from '@/components/common/brand-logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Callout, FieldError } from '@/components/common/misc';
import { authApi } from '@/lib/api/endpoints';
import { firstError } from '@/lib/form';
import { isApiError } from '@/lib/api/client';
import { applySession } from '@/lib/auth/session';
import { qk } from '@/lib/query/keys';

const route = getRouteApi('/ingresar');

const LoginFormSchema = z.object({
  email: z.string().trim().min(1, 'Ingresa tu correo').email('Correo inválido'),
  password: z.string().min(1, 'Ingresa tu contraseña'),
});

function loginErrorMessage(e: unknown): string {
  if (isApiError(e)) {
    if (e.status === 401) return 'Correo o contraseña incorrectos.';
    if (e.code === 'USER_DISABLED') return 'Tu cuenta está deshabilitada. Contacta a un administrador.';
    if (e.status === 429) {
      const s = e.retryAfterMs ? Math.ceil(e.retryAfterMs / 1000) : null;
      return s ? `Demasiados intentos. Espera ${s} s antes de volver a intentar.` : 'Demasiados intentos. Espera un momento.';
    }
    if (e.isNetwork) return 'No se pudo conectar con el servidor.';
  }
  return 'No se pudo iniciar sesión. Intenta de nuevo.';
}

export function LoginPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showPassword, setShowPassword] = useState(false);
  const providers = useQuery({ queryKey: qk.authProviders(), queryFn: ({ signal }) => authApi.providers(signal), retry: false });

  const login = useMutation({
    mutationFn: authApi.login,
    onSuccess: (me) => {
      qc.clear();
      applySession(me);
      qc.setQueryData(qk.session(), me);
      void navigate({ to: search.redirect ?? '/', replace: true });
    },
  });

  const form = useForm({
    defaultValues: { email: '', password: '' },
    validators: { onSubmit: LoginFormSchema },
    onSubmit: ({ value }) => login.mutateAsync({ email: value.email.trim().toLowerCase(), password: value.password }).catch(() => undefined),
  });

  const oidc = providers.data?.oidc.enabled ? providers.data.oidc : null;

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <section className="login-grid relative hidden flex-col justify-between p-12 lg:flex" aria-label="Katalyst">
        <BrandLogo variant="login" />
        <div>
          <h1 className="text-[48px] leading-[1.15] font-extrabold tracking-[-0.03em]">
            <span className="block text-[#eaebef]">Tus casos de TestRail,</span>
            <span className="block text-primary">corriendo solos.</span>
          </h1>
          <p className="mt-6 max-w-md text-[16px] text-[#aaabb2]">
            Graba flujos, prográmalos por día y hora y revisa resultados y rendimiento en un solo lugar.
          </p>
        </div>
        <p className="font-mono text-[12px] text-muted-foreground">Playwright · TestRail · DXMon</p>
      </section>

      <main className="flex items-center justify-center bg-background px-6 py-12">
        <div className="w-full max-w-[384px]">
          <div className="mb-8 lg:hidden">
            <div className="inline-block rounded-md bg-brand-ink px-4 py-3">
              <BrandLogo />
            </div>
          </div>
          <h2 className="text-[22px] font-bold tracking-tight">Ingresar</h2>
          <p className="mt-1 text-muted-foreground">Usa tu cuenta de la empresa.</p>

          {search.motivo === 'expirada' ? (
            <Callout tone="warning" className="mt-6">
              Tu sesión expiró, vuelve a ingresar.
            </Callout>
          ) : null}

          {oidc?.loginUrl ? (
            <>
              <Button asChild variant="outlineCard" className="mt-6 w-full">
                <a href={oidc.loginUrl}>Continuar con {oidc.displayName ?? 'SSO de la empresa'}</a>
              </Button>
              <div className="my-6 flex items-center gap-4 text-[13px] text-muted-foreground" aria-hidden>
                <span className="h-px flex-1 bg-border" />o<span className="h-px flex-1 bg-border" />
              </div>
            </>
          ) : (
            <div className="h-6" />
          )}

          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void form.handleSubmit();
            }}
            className="space-y-4"
          >
            <form.Field name="email">
              {(field) => {
                const error = field.state.meta.isTouched || form.state.submissionAttempts > 0 ? firstError(field.state.meta.errors) : null;
                return (
                  <div className="space-y-2">
                    <Label htmlFor="email">Correo</Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="username"
                      inputMode="email"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      aria-invalid={!!error}
                      aria-describedby={error ? 'email-error' : undefined}
                    />
                    <FieldError id="email-error" message={error} />
                  </div>
                );
              }}
            </form.Field>
            <form.Field name="password">
              {(field) => {
                const error = form.state.submissionAttempts > 0 ? firstError(field.state.meta.errors) : null;
                return (
                  <div className="space-y-2">
                    <Label htmlFor="password">Contraseña</Label>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                        aria-invalid={!!error}
                        aria-describedby={error ? 'password-error' : undefined}
                        className="pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                        aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                      >
                        {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                    <FieldError id="password-error" message={error} />
                  </div>
                );
              }}
            </form.Field>

            {login.isError ? (
              <p role="alert" className="rounded-md border border-alert-border bg-alert-bg px-3 py-2 text-[14px]">
                {loginErrorMessage(login.error)}
              </p>
            ) : null}

            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(submitting) => (
                <Button type="submit" className="mt-2 w-full" disabled={submitting || login.isPending}>
                  {submitting || login.isPending ? <Loader2 className="animate-spin" /> : null}
                  Ingresar
                </Button>
              )}
            </form.Subscribe>
          </form>
        </div>
      </main>
    </div>
  );
}

/**
 * Pantalla de grabación (captura 06 adaptada a ventana propia): estado, pasos y verificaciones reconocidas,
 * advertencias, Iniciar/Detener/Descartar/Agregar verificación/Enviar PR, validación local y URL del PR.
 * RF-GRB-01, RF-GRB-02, RF-GRB-06, ESP §13.6, RNF-USA-02.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Circle,
  CircleCheck,
  ExternalLink,
  GitPullRequest,
  LogIn,
  RotateCcw,
  ShieldCheck,
  Square,
  SquareCheck,
  Trash2,
  WandSparkles,
} from 'lucide-react';
import type { AppState, RecordingDraft, RecordingView, ValidationView } from '../../../shared/ipc';
import { Badge, Button, Callout, Card, ConfirmDialog, MonoLabel, Spinner, TagChip } from '../components/ui';
import { formatRemaining, useCommand, useNow } from '../lib/bridge';
import { RecordingStatusBadge } from './status';

const TAG_RE = /^@[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function RecordingScreen({ recording: r }: { state: AppState; recording: RecordingView }) {
  const cmd = useCommand();
  const now = useNow();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const recordingLive = r.phase === 'grabando' || r.phase === 'iniciando';
  const title = recordingLive ? `Grabando ${r.caseRef}` : `Grabación ${r.caseRef}`;

  return (
    <>
      <div>
        <Button
          variant="ghost"
          className="-ml-3"
          icon={<ArrowLeft className="size-4" aria-hidden />}
          disabled={recordingLive || r.phase === 'enviando' || r.phase === 'login'}
          onClick={() => void cmd.run(() => window.katalyst.closeRecording())}
        >
          Grabaciones
        </Button>
      </div>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-3 text-[30px] leading-9 font-bold tracking-[-0.03em]">
            {recordingLive && <span className="size-3 animate-pulse rounded-full bg-destructive" aria-hidden />}
            {title}
          </h1>
          <p className="mt-1 text-[15px] text-muted-foreground">
            {r.environmentName ?? 'Ambiente'} · {formatRemaining(r.expiresAt, now)}
            {r.appUrl && <span className="ml-2 font-mono text-[13px]">{r.appUrl}</span>}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {r.tags.map((t) => (
              <TagChip key={t}>{t}</TagChip>
            ))}
            {r.serverStatus && <RecordingStatusBadge status={r.serverStatus} />}
          </div>
        </div>
      </header>

      {r.message && (
        <Callout kind={r.phase === 'error' || r.phase === 'bloqueada' ? 'error' : 'info'}>{r.message}</Callout>
      )}
      {cmd.error && <Callout kind="error">{cmd.error}</Callout>}

      <PhaseBody r={r} cmd={cmd} onDiscard={() => setConfirmDiscard(true)} />

      <ConfirmDialog
        open={confirmDiscard}
        title="¿Descartar la grabación?"
        body="Se borran los pasos grabados y la sesión de este equipo, y la grabación se cancela en Katalyst. No se puede deshacer."
        confirmLabel="Descartar"
        destructive
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          void cmd.run(() => window.katalyst.discard());
        }}
      />
    </>
  );
}

type Cmd = ReturnType<typeof useCommand>;

function PhaseBody({ r, cmd, onDiscard }: { r: RecordingView; cmd: Cmd; onDiscard: () => void }) {
  const discardBtn = (
    <Button variant="ghost" icon={<Trash2 className="size-4" aria-hidden />} disabled={cmd.pending} onClick={onDiscard}>
      Descartar
    </Button>
  );
  switch (r.phase) {
    case 'cargando':
      return <Spinner label="Cargando la grabación…" />;
    case 'bloqueada':
      return (
        <Callout kind="blocked" title="Grabación bloqueada">
          El asistente no abre el navegador en producción ni en ambientes sin grabación habilitada. Crea la grabación
          desde el panel en un ambiente de pruebas.
        </Callout>
      );
    case 'lista':
      return (
        <Card title="1 · Inicia sesión en el ambiente de pruebas">
          <div className="space-y-4 text-[15px]">
            <p>
              Se abrirá Chromium en <strong>{r.environmentName ?? 'el ambiente'}</strong>. Inicia sesión con tu usuario
              autorizado (incluido el código MFA si lo pide).{' '}
              <strong>La captura está en pausa mientras inicias sesión</strong> y las credenciales nunca salen de tu
              equipo.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                icon={<LogIn className="size-4" aria-hidden />}
                loading={cmd.pending}
                onClick={() => void cmd.run(() => window.katalyst.startLogin())}
              >
                Abrir Chromium para iniciar sesión
              </Button>
              <Button
                variant="outline"
                icon={<Circle className="size-3.5 fill-destructive text-destructive" aria-hidden />}
                disabled={cmd.pending}
                onClick={() => void cmd.run(() => window.katalyst.startCapture(true))}
              >
                {r.hasStorageState ? 'Grabar con la sesión ya iniciada' : 'Grabar sin iniciar sesión'}
              </Button>
              {discardBtn}
            </div>
          </div>
        </Card>
      );
    case 'login':
      return (
        <Card title="Captura en pausa">
          <div className="space-y-4 text-[15px]">
            <p>
              Inicia sesión en la ventana de Chromium. Cuando veas la aplicación lista, pulsa{' '}
              <strong>Comenzar a grabar</strong>: el asistente cierra esa ventana y abre la grabadora con tu sesión.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                icon={<Circle className="size-3.5 fill-destructive text-destructive" aria-hidden />}
                loading={cmd.pending}
                onClick={() => void cmd.run(() => window.katalyst.startCapture(false))}
              >
                Comenzar a grabar
              </Button>
              {discardBtn}
            </div>
          </div>
        </Card>
      );
    case 'iniciando':
      return <Spinner label="Abriendo la grabadora de Playwright…" />;
    case 'grabando':
      return (
        <Card title="Pasos capturados" meta={<StepCounts r={r} />}>
          <div className="space-y-4">
            <p className="text-[15px] text-muted-foreground">
              El asistente abrió Chromium en {r.environmentName ?? 'el ambiente de pruebas'}. Interactúa con la app; las
              credenciales nunca salen de tu equipo.
            </p>
            {r.verificationGuide && (
              <Callout kind="info" title="Agregar verificación">
                En la barra flotante de la grabadora elige <strong>Assert visibility</strong> (visible),{' '}
                <strong>Assert text</strong> (texto) o <strong>Assert value</strong> (valor de un campo) y haz clic en
                el elemento que demuestra el resultado esperado.
              </Callout>
            )}
            <StepsBox r={r} />
            <Footer>
              {discardBtn}
              <Button
                variant="outline"
                icon={<SquareCheck className="size-4" aria-hidden />}
                disabled={cmd.pending}
                onClick={() => void cmd.run(() => window.katalyst.addVerification())}
              >
                Agregar verificación
              </Button>
              <Button
                variant="outline"
                icon={<Square className="size-4" aria-hidden />}
                loading={cmd.pending}
                onClick={() => void cmd.run(() => window.katalyst.stopCapture())}
              >
                Detener
              </Button>
              <Button
                variant="primary"
                icon={<GitPullRequest className="size-4" aria-hidden />}
                disabled={cmd.pending || r.steps.length === 0}
                onClick={() => void cmd.run(() => window.katalyst.stopCapture())}
                title="Detiene la grabación y abre la revisión antes de enviar"
              >
                Enviar PR
              </Button>
            </Footer>
          </div>
        </Card>
      );
    case 'detenida':
    case 'enviando':
      return <ReviewPanel r={r} cmd={cmd} discardBtn={discardBtn} />;
    case 'enviada':
      return (
        <Card title="Pull request">
          <div className="space-y-4">
            <Callout kind="success" title={r.prUrl ? 'Pull request abierto' : 'Grabación enviada'}>
              {r.prUrl
                ? 'Un desarrollador revisará el test, lo refactorizará a Page Objects y completará verificaciones antes de aprobarlo.'
                : (r.message ?? 'Katalyst está validando la grabación.')}
            </Callout>
            {r.prUrl && (
              <div className="flex flex-wrap items-center gap-3">
                <span className="truncate font-mono text-sm">{r.prUrl}</span>
                <Button
                  variant="primary"
                  icon={<ExternalLink className="size-4" aria-hidden />}
                  onClick={() => void cmd.run(() => window.katalyst.openPullRequest())}
                >
                  Abrir pull request
                </Button>
              </div>
            )}
            {r.rejectionReasons.length > 0 && (
              <Callout kind="warning" title="Pendiente para el desarrollador antes de aprobar">
                <ul className="list-disc space-y-0.5 pl-4">
                  {r.rejectionReasons.map((x, i) => (
                    <li key={`${x.code}-${i}`}>
                      {x.message}
                      {x.line !== null && <span className="ml-1 font-mono text-xs opacity-70">línea {x.line}</span>}
                    </li>
                  ))}
                </ul>
              </Callout>
            )}
            <p className="text-[13px] text-muted-foreground">
              El código y la sesión locales ya se borraron de este equipo.
            </p>
          </div>
        </Card>
      );
    case 'rechazada':
      return (
        <Card title="Grabación rechazada">
          <ul className="space-y-2 text-[15px]">
            {r.rejectionReasons.length === 0 && <li>Katalyst no indicó motivos.</li>}
            {r.rejectionReasons.map((x, i) => (
              <li key={`${x.code}-${i}`} className="flex gap-2">
                <Badge tone="failed">{x.code}</Badge>
                <span>
                  {x.message}
                  {x.line !== null && (
                    <span className="ml-1 font-mono text-xs text-muted-foreground">línea {x.line}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      );
    case 'cancelada':
      return (
        <Callout kind="info" title="Grabación descartada">
          Se borró todo lo grabado en este equipo.
        </Callout>
      );
    case 'vencida':
      return (
        <Callout kind="warning" title="Grabación vencida">
          Las grabaciones duran 2 horas. Crea una nueva desde el panel.
        </Callout>
      );
    case 'error':
      return (
        <Footer>
          {discardBtn}
          <Button
            variant="primary"
            icon={<RotateCcw className="size-4" aria-hidden />}
            loading={cmd.pending}
            onClick={() => void cmd.run(() => window.katalyst.rerecord())}
          >
            Volver a grabar
          </Button>
        </Footer>
      );
  }
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 pt-1">{children}</div>;
}

function StepCounts({ r }: { r: RecordingView }) {
  const actions = r.steps.filter((s) => s.kind === 'accion').length;
  const checks = r.steps.filter((s) => s.kind === 'verificacion').length;
  const unsupported = r.steps.filter((s) => s.kind === 'no_soportada').length;
  return (
    <span>
      {actions} acciones · {checks} verificaciones{unsupported ? ` · ${unsupported} no soportadas` : ''}
    </span>
  );
}

function StepsBox({ r }: { r: RecordingView }) {
  const stepWarnings = r.warnings.filter((w) => w.line !== null);
  const general = r.warnings.filter((w) => w.line === null);
  return (
    <div
      className="max-h-80 overflow-y-auto rounded-lg border border-border bg-muted px-4 py-3 font-mono text-[12.5px] leading-6"
      aria-live="polite"
    >
      {r.steps.length === 0 && <p className="text-muted-foreground">Esperando la primera acción…</p>}
      <ol className="space-y-0.5">
        {r.steps.map((s) => {
          const ws = stepWarnings.filter((w) => w.line === s.line);
          return (
            <li key={`${s.index}-${s.line}`}>
              <span
                className={s.kind === 'no_soportada' ? 'text-failed' : s.kind === 'verificacion' ? 'text-passed' : ''}
              >
                {s.kind === 'no_soportada' ? '✗' : s.kind === 'verificacion' ? '✓✓' : '✓'} {s.index}. {s.description}
              </span>
              {ws.map((w, i) => (
                <div key={i} className="pl-6 text-flaky">
                  ⚠ {w.message}
                </div>
              ))}
            </li>
          );
        })}
      </ol>
      {general.map((w, i) => (
        <p key={i} className="mt-1 text-flaky">
          ⚠ {w.message}
        </p>
      ))}
    </div>
  );
}

function ReviewPanel({ r, cmd, discardBtn }: { r: RecordingView; cmd: Cmd; discardBtn: ReactNode }) {
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState<string[]>(r.tags);
  const [tagInput, setTagInput] = useState('');
  const [classification, setClassification] = useState<RecordingDraft['classification']>('lectura');
  const [ack, setAck] = useState(false);
  const draft: RecordingDraft = useMemo(
    () => ({ title: title.trim() || `${r.caseRef} Grabación`, tags, classification }),
    [title, tags, classification, r.caseRef],
  );
  const v = r.validation;
  const sending = r.phase === 'enviando';
  const hasSecrets = v?.issues.some((i) => i.code === 'SECRET_DETECTED') ?? false;
  const warnings = v?.issues.filter((i) => i.severity === 'advertencia') ?? [];
  const validateCmd = useCommand();
  const runValidate = validateCmd.run;

  // Revalida al cambiar el borrador (validación local, sin red).
  useEffect(() => {
    const t = setTimeout(() => void runValidate(() => window.katalyst.validateDraft(draft)), 300);
    return () => clearTimeout(t);
  }, [draft, runValidate, r.codePreview]);
  useEffect(() => setAck(false), [draft, r.codePreview]);

  const addTag = () => {
    const t = tagInput.trim().startsWith('@') ? tagInput.trim() : `@${tagInput.trim()}`;
    if (TAG_RE.test(t) && !tags.includes(t)) setTags([...tags, t]);
    setTagInput('');
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card title="Pasos grabados" meta={<StepCounts r={r} />}>
        <StepsBox r={r} />
        {r.codePreview && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium">Ver código generado</summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-code-bg p-4 font-mono text-[12.5px] leading-[19.5px] text-code-fg">
              {r.codePreview}
            </pre>
          </details>
        )}
      </Card>
      <Card title="Enviar como pull request">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void cmd.run(() => window.katalyst.submit(draft, ack));
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="title" className="block text-[15px] font-medium">
              Título del test
            </label>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-primary">{r.caseRef}</span>
              <input
                id="title"
                value={title}
                maxLength={280}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Abrir Órdenes de carga y filtrar"
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-card px-3 text-[15px] placeholder:text-placeholder focus:ring-2 focus:ring-primary focus:outline-none"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <MonoLabel>Etiquetas</MonoLabel>
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.map((t) => (
                <TagChip key={t} onRemove={() => setTags(tags.filter((x) => x !== t))}>
                  {t}
                </TagChip>
              ))}
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addTag();
                  }
                }}
                onBlur={() => tagInput && addTag()}
                placeholder="@etiqueta"
                aria-label="Nueva etiqueta"
                className="h-7 w-32 rounded-sm border border-border bg-card px-2 font-mono text-xs focus:ring-2 focus:ring-primary focus:outline-none"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <MonoLabel>Clasificación</MonoLabel>
            <div
              className="flex w-fit rounded-md border border-border bg-card p-1"
              role="radiogroup"
              aria-label="Clasificación"
            >
              {(
                [
                  ['lectura', 'Lectura'],
                  ['escritura', 'Escritura'],
                  ['sin_clasificar', 'Sin clasificar'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={classification === value}
                  onClick={() => setClassification(value)}
                  className={`rounded-sm px-3 py-1 text-sm ${classification === value ? 'bg-primary text-primary-foreground' : ''}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {classification === 'sin_clasificar' && (
              <p className="text-[13px] text-flaky">
                Un test sin clasificar no puede aprobarse ni correr en producción.
              </p>
            )}
          </div>

          <ValidationBox v={v} />

          {hasSecrets && (
            <Button
              variant="soft"
              icon={<WandSparkles className="size-4" aria-hidden />}
              disabled={cmd.pending || sending}
              onClick={() => void cmd.run(() => window.katalyst.maskSensitive())}
            >
              Reemplazar datos sensibles por marcadores
            </Button>
          )}
          {v?.ok && warnings.length > 0 && (
            <label className="flex items-start gap-2 text-[14px]">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                className="mt-1 size-4 accent-[#ea9300]"
              />
              Revisé las advertencias. Entiendo que el desarrollador debe completar verificaciones y selectores antes de
              aprobar.
            </label>
          )}
          <Footer>
            {discardBtn}
            <Button
              variant="outline"
              icon={<RotateCcw className="size-4" aria-hidden />}
              disabled={cmd.pending || sending}
              onClick={() => void cmd.run(() => window.katalyst.rerecord())}
            >
              Volver a grabar
            </Button>
            <Button
              type="submit"
              variant="primary"
              icon={<GitPullRequest className="size-4" aria-hidden />}
              loading={sending}
              disabled={cmd.pending || !v?.ok || (warnings.length > 0 && !ack)}
            >
              Enviar PR
            </Button>
          </Footer>
          {sending && <Spinner label="Validando en Katalyst y abriendo el pull request…" />}
        </form>
      </Card>
    </div>
  );
}

function ValidationBox({ v }: { v: ValidationView | null }) {
  if (!v) return <Spinner label="Revisando el código…" />;
  const errors = v.issues.filter((i) => i.severity === 'error');
  const warnings = v.issues.filter((i) => i.severity === 'advertencia');
  return (
    <div className="space-y-2">
      {errors.length === 0 && warnings.length === 0 && (
        <Callout kind="success" title="Listo para enviar">
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="size-4" aria-hidden /> Sin secretos, sin esperas fijas y con verificaciones.
          </span>
        </Callout>
      )}
      {errors.length > 0 && (
        <Callout kind="error" title="Corrige antes de enviar">
          <IssueList items={errors} />
        </Callout>
      )}
      {warnings.length > 0 && (
        <Callout kind="warning" title="Advertencias">
          <IssueList items={warnings} />
        </Callout>
      )}
      <p className="font-mono text-[11px] text-muted-foreground">
        <CircleCheck className="mr-1 inline size-3" aria-hidden />
        {(v.bytes / 1024).toLocaleString('es-BO', { maximumFractionDigits: 1 })} KiB de 1024 KiB
      </p>
    </div>
  );
}

function IssueList({ items }: { items: ValidationView['issues'] }) {
  return (
    <ul className="list-disc space-y-0.5 pl-4">
      {items.map((i, k) => (
        <li key={`${i.code}-${k}`}>
          {i.message}
          {i.line !== null && <span className="ml-1 font-mono text-xs opacity-70">línea {i.line}</span>}
        </li>
      ))}
    </ul>
  );
}

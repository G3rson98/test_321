/**
 * RF-TR-06 · Destino de publicación en TestRail de una ejecución: corrida nueva (por defecto), corrida o Test Plan
 * existente, o no publicar. Para "existente" se leen en vivo, con los endpoints que ya expone la API,
 * `GET /testrail/plans/:planId` (corridas del plan) y `GET /testrail/runs/:trRunId/tests` (verificar una corrida por
 * ID). Cerrar una corrida preexistente es una opción explícita, desactivada por defecto (ESP §8).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SegmentedControl } from '@/components/common/controls';
import { Callout } from '@/components/common/misc';
import { testrailApi } from '@/lib/api/endpoints';
import { errorMessage, isApiError } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { cn, plural } from '@/lib/utils';

export type TargetMode = 'nueva' | 'existente' | 'ninguno';
export interface TargetValue {
  mode: TargetMode;
  trRunId: number | null;
  closeExistingRun: boolean;
}

type Source = 'plan' | 'corrida';
const parseId = (s: string): number | null => (/^\d{1,9}$/.test(s.trim()) && Number(s) > 0 ? Number(s) : null);

function lookupMessage(e: unknown, what: string): string {
  return isApiError(e) && e.code === 'NOT_FOUND' ? `No existe ${what} en TestRail.` : errorMessage(e);
}

export function TestRailTargetPicker({ value, onChange }: { value: TargetValue; onChange: (v: TargetValue) => void }) {
  const [source, setSource] = useState<Source>('plan');
  const [planInput, setPlanInput] = useState('');
  const [planId, setPlanId] = useState<number | null>(null);
  const [runInput, setRunInput] = useState('');
  const [runId, setRunId] = useState<number | null>(null);
  const set = (patch: Partial<TargetValue>) => onChange({ ...value, ...patch });

  const plan = useQuery({
    queryKey: qk.testrail.plan(planId ?? 0),
    queryFn: ({ signal }) => testrailApi.plan(planId!, signal),
    enabled: value.mode === 'existente' && source === 'plan' && planId !== null,
    retry: false,
    staleTime: 60_000,
  });
  const run = useQuery({
    queryKey: qk.testrail.runTests(runId ?? 0),
    queryFn: ({ signal }) => testrailApi.runTests(runId!, signal),
    enabled: value.mode === 'existente' && source === 'corrida' && runId !== null,
    retry: false,
    staleTime: 60_000,
  });

  const planRuns = plan.data?.entries.flatMap((e) => e.runs) ?? [];
  const planInvalid = planInput.trim() !== '' && parseId(planInput) === null;
  const runInvalid = runInput.trim() !== '' && parseId(runInput) === null;

  return (
    <div className="space-y-2.5">
      <Label id="tr-target-label">Destino en TestRail</Label>
      <SegmentedControl
        ariaLabel="Destino en TestRail"
        value={value.mode}
        onValueChange={(mode) => set({ mode, ...(mode === 'existente' ? {} : { trRunId: null, closeExistingRun: false }) })}
        className="text-[13px]"
        options={[
          { value: 'nueva', label: 'Corrida nueva' },
          { value: 'existente', label: 'Plan o corrida existente' },
          { value: 'ninguno', label: 'No publicar' },
        ]}
      />
      {value.mode === 'existente' ? (
        <div className="space-y-3 rounded-md border border-border p-3.5">
          <SegmentedControl
            ariaLabel="Origen de la corrida existente"
            value={source}
            onValueChange={(s) => {
              setSource(s);
              set({ trRunId: null, closeExistingRun: false });
            }}
            className="text-[13px]"
            options={[
              { value: 'plan', label: 'Desde un Test Plan' },
              { value: 'corrida', label: 'Por ID de corrida' },
            ]}
          />
          {source === 'plan' ? (
            <div className="space-y-3">
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  setPlanId(parseId(planInput));
                  set({ trRunId: null });
                }}
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="tr-plan-id">ID del Test Plan</Label>
                  <Input id="tr-plan-id" inputMode="numeric" placeholder="p. ej. 7001" value={planInput} onChange={(e) => setPlanInput(e.target.value)} aria-invalid={planInvalid} />
                </div>
                <Button type="submit" size="sm" variant="outlineCard" disabled={parseId(planInput) === null || plan.isFetching}>
                  {plan.isFetching ? <Loader2 className="animate-spin" /> : <Search />} Buscar plan
                </Button>
              </form>
              {plan.isError ? (
                <p role="alert" className="text-[13px] text-destructive">
                  {lookupMessage(plan.error, 'ese plan')}
                </p>
              ) : plan.data ? (
                planRuns.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">El plan «{plan.data.name}» no tiene corridas.</p>
                ) : (
                  <fieldset className="space-y-1.5">
                    <legend className="mb-1.5 text-[13px] text-muted-foreground">
                      Plan «{plan.data.name}» · {planRuns.length} {plural(planRuns.length, 'corrida', 'corridas')}
                    </legend>
                    {planRuns.map((r) => (
                      <label
                        key={r.trRunId}
                        className={cn(
                          'flex cursor-pointer items-center gap-2.5 rounded-md border border-border px-3 py-2 text-[14px]',
                          value.trRunId === r.trRunId && 'border-primary ring-2 ring-primary/30',
                          r.isCompleted && 'cursor-not-allowed opacity-60',
                        )}
                      >
                        <input
                          type="radio"
                          name="tr-plan-run"
                          className="accent-[var(--color-primary)]"
                          checked={value.trRunId === r.trRunId}
                          disabled={r.isCompleted}
                          onChange={() => set({ trRunId: r.trRunId })}
                        />
                        <span className="min-w-0 flex-1 truncate">{r.name}</span>
                        <span className="font-mono text-[12.5px] text-muted-foreground">R{r.trRunId}</span>
                        {r.isCompleted ? <span className="text-[12.5px] text-muted-foreground">Cerrada</span> : null}
                      </label>
                    ))}
                  </fieldset>
                )
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  setRunId(parseId(runInput));
                  set({ trRunId: null });
                }}
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="tr-run-id">ID de la corrida de TestRail</Label>
                  <Input id="tr-run-id" inputMode="numeric" placeholder="p. ej. 3301" value={runInput} onChange={(e) => setRunInput(e.target.value)} aria-invalid={runInvalid} />
                </div>
                <Button type="submit" size="sm" variant="outlineCard" disabled={parseId(runInput) === null || run.isFetching}>
                  {run.isFetching ? <Loader2 className="animate-spin" /> : <Search />} Verificar corrida
                </Button>
              </form>
              {run.isError ? (
                <p role="alert" className="text-[13px] text-destructive">
                  {lookupMessage(run.error, 'esa corrida')}
                </p>
              ) : run.data ? (
                <div className="flex items-center justify-between gap-3 text-[14px]">
                  <span className="inline-flex items-center gap-1.5">
                    <CheckCircle2 className="size-4 text-passed" aria-hidden /> Corrida R{run.data.trRunId} · {run.data.tests.length} {plural(run.data.tests.length, 'test', 'tests')}
                  </span>
                  <Button size="sm" variant={value.trRunId === run.data.trRunId ? 'default' : 'outlineCard'} onClick={() => set({ trRunId: run.data!.trRunId })}>
                    {value.trRunId === run.data.trRunId ? 'Seleccionada' : 'Usar esta corrida'}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
          {value.trRunId === null ? (
            <p className="text-[13px] text-muted-foreground">Elige la corrida donde se publicarán los resultados.</p>
          ) : (
            <label className="flex items-start gap-2.5 text-[14px]">
              <Checkbox checked={value.closeExistingRun} onCheckedChange={(v) => set({ closeExistingRun: v === true })} className="mt-0.5" />
              <span>
                Cerrar la corrida R{value.trRunId} en TestRail al terminar
                <span className="block text-[12.5px] text-muted-foreground">Es una acción irreversible; por defecto la corrida queda abierta.</span>
              </span>
            </label>
          )}
          {value.closeExistingRun && value.trRunId !== null ? (
            <Callout tone="warning" className="py-2.5 text-[13.5px]">
              La corrida R{value.trRunId} se cerrará al publicar los resultados y ya no admitirá nuevos resultados.
            </Callout>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

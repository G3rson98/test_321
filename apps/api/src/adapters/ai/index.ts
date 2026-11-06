/**
 * Interfaz `AiProvider` (plan §4.5; proveedor pendiente ESP §12, recomendado Claude por API). Una llamada única sin
 * herramientas (los pasos/código del usuario son datos no confiables y el modelo no puede ejecutar nada), con
 * timeout y tope de tokens de salida derivado del presupuesto por solicitud (ESP §13.7, §18).
 * RF-GRB-03, RF-GRB-04.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface AiCompletionRequest {
  system: string;
  /** Contenido del usuario ya delimitado/sanitizado por el llamador. */
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface AiCompletion {
  text: string;
  model: string;
  usage: AiUsage;
  stopReason: string | null;
}

export type AiErrorKind = 'timeout' | 'unavailable' | 'rate_limited' | 'auth' | 'rejected' | 'refusal';

export class AiProviderError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export interface AiPricing {
  /** USD por millón de tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  readonly pricing: AiPricing;
  complete(req: AiCompletionRequest): Promise<AiCompletion>;
}

/** Precios de lista (USD/MTok) verificados el 2026-11-06 en la documentación de Anthropic; configurables. */
export const ANTHROPIC_PRICING: Record<string, AiPricing> = {
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 },
};
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

export function costUsd(usage: AiUsage, p: AiPricing): number {
  const v =
    (usage.inputTokens * p.inputPerMTok +
      usage.outputTokens * p.outputPerMTok +
      usage.cacheReadInputTokens * p.cacheReadPerMTok +
      usage.cacheCreationInputTokens * p.cacheWritePerMTok) /
    1_000_000;
  return Math.round(v * 1e6) / 1e6;
}

/** Estimación conservadora de tokens de entrada (≈ 3 caracteres por token, sin llamar al proveedor). */
export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / 3) + 50;
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  pricing?: AiPricing;
  baseURL?: string;
  /** Esfuerzo (Claude Opus 5.5: el pensamiento adaptativo siempre está activo; default del modelo `medium`). */
  effort?: 'low' | 'medium' | 'high';
}

/** Adaptador Anthropic (SDK oficial `@anthropic-ai/sdk`). Sin herramientas, sin streaming, sin reintentos ocultos. */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly pricing: AiPricing;
  private readonly client: Anthropic;
  private readonly effort: 'low' | 'medium' | 'high';

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model || DEFAULT_ANTHROPIC_MODEL;
    this.pricing = opts.pricing ?? ANTHROPIC_PRICING[this.model] ?? ANTHROPIC_PRICING[DEFAULT_ANTHROPIC_MODEL]!;
    this.effort = opts.effort ?? 'medium';
    // maxRetries 0: un reintento duplicaría costo fuera del presupuesto reservado.
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: 0,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async complete(req: AiCompletionRequest): Promise<AiCompletion> {
    try {
      const res = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          output_config: { effort: this.effort },
          messages: [{ role: 'user', content: req.user }],
        },
        { timeout: req.timeoutMs },
      );
      if (res.stop_reason === 'refusal') {
        throw new AiProviderError('refusal', 'El modelo declinó la solicitud');
      }
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return {
        text,
        model: res.model,
        stopReason: res.stop_reason ?? null,
        usage: {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
          cacheReadInputTokens: res.usage.cache_read_input_tokens ?? 0,
          cacheCreationInputTokens: res.usage.cache_creation_input_tokens ?? 0,
        },
      };
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      if (err instanceof Anthropic.APIConnectionTimeoutError) throw new AiProviderError('timeout', 'Tiempo agotado');
      if (err instanceof Anthropic.APIConnectionError) throw new AiProviderError('unavailable', 'Sin conexión');
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new AiProviderError('auth', 'Credencial del proveedor rechazada');
      }
      if (err instanceof Anthropic.RateLimitError) throw new AiProviderError('rate_limited', 'Límite del proveedor');
      if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) {
        throw new AiProviderError('rejected', 'Solicitud rechazada por el proveedor');
      }
      if (err instanceof Anthropic.APIError) throw new AiProviderError('unavailable', `Proveedor respondió ${err.status}`);
      throw new AiProviderError('unavailable', 'Error del proveedor');
    }
  }
}

/** Proveedor falso para pruebas: devuelve respuestas programadas y registra los prompts recibidos. */
export class FakeAiProvider implements AiProvider {
  readonly name = 'fake';
  readonly calls: AiCompletionRequest[] = [];
  readonly pricing: AiPricing = ANTHROPIC_PRICING[DEFAULT_ANTHROPIC_MODEL]!;
  constructor(
    private readonly responder: (req: AiCompletionRequest) => string | Promise<string>,
    readonly model = 'fake-model',
    private readonly usage: Partial<AiUsage> = {},
  ) {}
  async complete(req: AiCompletionRequest): Promise<AiCompletion> {
    this.calls.push(req);
    const text = await this.responder(req);
    return {
      text,
      model: this.model,
      stopReason: 'end_turn',
      usage: {
        inputTokens: this.usage.inputTokens ?? estimateInputTokens(req.system + req.user),
        outputTokens: this.usage.outputTokens ?? Math.ceil(text.length / 3),
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    };
  }
}

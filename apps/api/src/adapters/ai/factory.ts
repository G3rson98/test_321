/**
 * Fábrica del proveedor IA según configuración (`AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY_REF`). La clave se resuelve
 * por SecretProvider en el momento de uso, nunca se registra. RF-GRB-03, RF-GRB-04.
 */
import type { Config } from '../../config.js';
import { getSecretProvider, type SecretProvider } from '../../lib/secrets.js';
import { apiCSettings } from '../../modules/recordings/settings.js';
import { ANTHROPIC_PRICING, AnthropicProvider, DEFAULT_ANTHROPIC_MODEL, type AiProvider } from './index.js';

let override: AiProvider | null | undefined;
export function setAiProvider(p: AiProvider | null | undefined): void {
  override = p;
}

export async function getAiProvider(
  config: Config,
  secrets: SecretProvider = getSecretProvider(),
): Promise<AiProvider | null> {
  if (override !== undefined) return override;
  if (config.AI_PROVIDER !== 'anthropic' || !config.AI_API_KEY_REF) return null;
  const s = apiCSettings();
  const model = config.AI_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const base = ANTHROPIC_PRICING[model] ?? ANTHROPIC_PRICING[DEFAULT_ANTHROPIC_MODEL]!;
  const pricing = {
    ...base,
    ...(s.AI_PRICE_INPUT_PER_MTOK !== undefined ? { inputPerMTok: s.AI_PRICE_INPUT_PER_MTOK } : {}),
    ...(s.AI_PRICE_OUTPUT_PER_MTOK !== undefined ? { outputPerMTok: s.AI_PRICE_OUTPUT_PER_MTOK } : {}),
  };
  const apiKey = await secrets.get(config.AI_API_KEY_REF);
  return new AnthropicProvider({ apiKey, model, pricing, effort: s.AI_EFFORT });
}

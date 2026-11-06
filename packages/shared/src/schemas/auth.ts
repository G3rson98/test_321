/**
 * Autenticación del panel y credenciales API (RF-USR-01, RF-USR-03, RNF-SEG-01, RNF-SEG-03, ESP §13.7).
 * Sesión por cookie HttpOnly/Secure/SameSite; los tokens nunca se devuelven salvo al crearlos (una sola vez).
 */
import { z } from 'zod';
import { ApiCredentialKindSchema, PanelRoleSchema } from '../enums.js';
import { IsoDateTimeSchema, UuidSchema } from './common.js';
import { PermissionSchema } from '../rbac/permissions.js';

export const EmailSchema = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());

/** `POST /api/v1/auth/login` (autenticación propia; OIDC corporativo opcional, ESP §12). */
export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/** Identidad actual: `GET /api/v1/auth/me` y respuesta de login. */
export const MeResponseSchema = z.object({
  user: z.object({
    id: UuidSchema,
    email: z.string(),
    name: z.string(),
    role: PanelRoleSchema,
  }),
  permissions: z.array(PermissionSchema),
  session: z.object({
    expiresAt: IsoDateTimeSchema,
    /** Token CSRF para encabezado `X-CSRF-Token` (doble envío); no es credencial. */
    csrfToken: z.string(),
  }),
  /** Zona de presentación (RNF-USA-01). */
  timezone: z.string(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const LoginResponseSchema = MeResponseSchema;
export type LoginResponse = MeResponse;

/** `POST /api/v1/auth/logout` → 204 o `{ ok: true }`. */
export const LogoutResponseSchema = z.object({ ok: z.literal(true) });

/** Descubrimiento del método de login (`GET /api/v1/auth/providers`). */
export const AuthProvidersResponseSchema = z.object({
  local: z.boolean(),
  oidc: z.object({ enabled: z.boolean(), displayName: z.string().nullable(), loginUrl: z.string().nullable() }),
});

/** Recuperación de contraseña (auth propia: token único con vencimiento, ESP §13.7). */
export const PasswordResetRequestSchema = z.object({ email: EmailSchema });
export const PasswordResetConfirmSchema = z.object({
  token: z.string().min(32).max(256),
  newPassword: z.string().min(12).max(1024),
});
export const PasswordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(12).max(1024),
});

// ---------------------------------------------------------------------------
// Tokens API revocables con permisos (RF-USR-03)
// ---------------------------------------------------------------------------

export const ApiTokenCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(PermissionSchema).min(1),
  /** Vencimiento obligatorio, máximo 365 días. */
  expiresAt: IsoDateTimeSchema,
});
export type ApiTokenCreateRequest = z.infer<typeof ApiTokenCreateRequestSchema>;

export const ApiTokenSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  kind: ApiCredentialKindSchema,
  principalId: UuidSchema,
  scopes: z.array(PermissionSchema),
  /** Últimos 4 caracteres para identificarlo; el token completo no es recuperable. */
  hint: z.string(),
  expiresAt: IsoDateTimeSchema.nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
  lastUsedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;

/** Única respuesta que incluye el token en claro (endpoint dedicado de autenticación, RNF-SEG-01). */
export const ApiTokenCreatedResponseSchema = z.object({
  credential: ApiTokenSchema,
  token: z.string(),
});

// ---------------------------------------------------------------------------
// Credenciales de servicio del supervisor (RF-USR-03, ESP §13.3: alcance restringido y expirable)
// ---------------------------------------------------------------------------

/** Scopes admitidos para credenciales de servicio (solo actor de sistema). */
export const SERVICE_CREDENTIAL_SCOPES = ['worker.claim'] as const;

export const ServiceCredentialCreateRequestSchema = z.object({
  /** Nombre del principal de servicio, p. ej. `supervisor:host-1`. */
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._-]{1,64}$/, 'Formato esperado: tipo:nombre'),
  scopes: z.array(z.enum(SERVICE_CREDENTIAL_SCOPES)).min(1).default(['worker.claim']),
  /** Vigencia en días (acotada por configuración). */
  expiresInDays: z.number().int().min(1).max(365),
});
export type ServiceCredentialCreateRequest = z.infer<typeof ServiceCredentialCreateRequestSchema>;

export const ServiceCredentialSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  serviceName: z.string(),
  scopes: z.array(PermissionSchema),
  hint: z.string(),
  expiresAt: IsoDateTimeSchema.nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
  lastUsedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type ServiceCredential = z.infer<typeof ServiceCredentialSchema>;

export const ServiceCredentialCreatedResponseSchema = z.object({
  credential: ServiceCredentialSchema,
  token: z.string(),
});

/** Listado de tokens/credenciales (`GET /auth/tokens`, `/auth/service-credentials`). */
export const ApiTokenListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(512).optional(),
  includeRevoked: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
});

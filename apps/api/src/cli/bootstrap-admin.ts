/**
 * Identidad administrativa inicial (RF-USR-03): `pnpm --filter @katalyst/api bootstrap-admin -- --email a@b.c
 * [--name "Nombre"] (--password-stdin | --password-file /ruta | BOOTSTRAP_ADMIN_PASSWORD_REF) [--reset-password]`.
 * La contraseña NUNCA se acepta como argumento (visible en `ps`/historial, ESP §13.7). Idempotente: si el admin existe
 * no lo modifica salvo `--reset-password`. Auditado como actor `sistema`.
 *
 * También emite credenciales de servicio del supervisor:
 * `bootstrap-admin -- --service-credential supervisor:host-1 [--days 30]` imprime el token UNA vez en stdout.
 */
import { readFile } from 'node:fs/promises';
import { EmailSchema } from '@katalyst/shared';
import { loadConfig } from '../config.js';
import { createPrisma } from '../db.js';
import { recordAudit } from '../lib/audit.js';
import { hashPassword, PASSWORD_MIN_LENGTH } from '../lib/crypto-tokens.js';
import { getSecretProvider } from '../lib/secrets.js';
import { issueServiceCredential } from '../modules/auth/routes.js';

export interface BootstrapArgs {
  email?: string;
  name?: string;
  passwordStdin: boolean;
  passwordFile?: string;
  resetPassword: boolean;
  serviceCredential?: string;
  days?: number;
}

const FORBIDDEN_ARGS = ['--password', '-p', '--pass'];

export function parseArgs(argv: string[]): BootstrapArgs {
  const out: BootstrapArgs = { passwordStdin: false, resetPassword: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const next = () => inline ?? argv[++i];
    if (FORBIDDEN_ARGS.includes(flag)) {
      throw new Error('La contraseña no se acepta como argumento: usa --password-stdin o --password-file.');
    }
    switch (flag) {
      case '--':
        break;
      case '--email':
        out.email = next();
        break;
      case '--name':
        out.name = next();
        break;
      case '--password-stdin':
        out.passwordStdin = true;
        break;
      case '--password-file':
        out.passwordFile = next();
        break;
      case '--reset-password':
        out.resetPassword = true;
        break;
      case '--service-credential':
        out.serviceCredential = next();
        break;
      case '--days':
        out.days = Number(next());
        break;
      default:
        throw new Error(`Argumento desconocido: ${flag}`);
    }
  }
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function resolvePassword(
  args: BootstrapArgs,
  envRef: string | undefined,
  readStdinFn: () => Promise<string> = readStdin,
): Promise<string> {
  let pw: string | undefined;
  if (args.passwordStdin) pw = await readStdinFn();
  else if (args.passwordFile) pw = await readFile(args.passwordFile, 'utf8');
  else if (envRef) pw = await getSecretProvider().get(envRef);
  if (pw === undefined) throw new Error('Falta la contraseña: --password-stdin, --password-file o BOOTSTRAP_ADMIN_PASSWORD_REF.');
  pw = pw.replace(/\r?\n$/, '');
  if (pw.length < PASSWORD_MIN_LENGTH) throw new Error(`La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`);
  return pw;
}

export async function bootstrapAdmin(
  prisma: import('@prisma/client').PrismaClient,
  o: { email: string; name: string; password: string; resetPassword: boolean },
): Promise<{ action: 'created' | 'password_reset' | 'unchanged'; userId: string }> {
  const email = EmailSchema.parse(o.email);
  const passwordHash = await hashPassword(o.password);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.panelUser.findUnique({ where: { email } });
    if (existing) {
      if (!o.resetPassword) return { action: 'unchanged' as const, userId: existing.id };
      await tx.panelUser.update({
        where: { id: existing.id },
        data: { passwordHash, role: 'admin', disabledAt: null, version: { increment: 1 } },
      });
      await tx.panelSession.updateMany({ where: { userId: existing.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await recordAudit(tx, {
        actor: 'system',
        action: 'auth.password_reset',
        entity: 'panel_user',
        entityId: existing.id,
        diff: { via: 'bootstrap' },
      });
      return { action: 'password_reset' as const, userId: existing.id };
    }
    const u = await tx.panelUser.create({ data: { email, name: o.name, role: 'admin', passwordHash } });
    await recordAudit(tx, {
      actor: 'system',
      action: 'panel_user.create',
      entity: 'panel_user',
      entityId: u.id,
      diff: { email, role: 'admin', via: 'bootstrap' },
    });
    return { action: 'created' as const, userId: u.id };
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const prisma = createPrisma(config, 'control');
  try {
    if (args.serviceCredential) {
      const days = Math.min(args.days ?? config.SERVICE_CREDENTIAL_TTL_DAYS, config.SERVICE_CREDENTIAL_TTL_DAYS);
      const { token, credential } = await issueServiceCredential(prisma, {
        serviceName: args.serviceCredential,
        scopes: ['worker.claim'],
        expiresAt: new Date(Date.now() + days * 86_400_000),
        actor: 'system',
      });
      process.stderr.write(`Credencial ${credential.id} emitida (vence ${credential.expiresAt?.toISOString()}).\n`);
      process.stdout.write(`${token}\n`);
      return;
    }
    const email = args.email ?? config.BOOTSTRAP_ADMIN_EMAIL;
    if (!email) throw new Error('Falta --email o BOOTSTRAP_ADMIN_EMAIL.');
    const password = await resolvePassword(args, config.BOOTSTRAP_ADMIN_PASSWORD_REF);
    const r = await bootstrapAdmin(prisma, {
      email,
      name: args.name ?? 'Administrador',
      password,
      resetPassword: args.resetPassword,
    });
    process.stderr.write(
      r.action === 'created'
        ? 'Administrador inicial creado.\n'
        : r.action === 'password_reset'
          ? 'Contraseña del administrador restablecida (sesiones revocadas).\n'
          : 'El administrador ya existe; sin cambios (usa --reset-password para restablecer).\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`bootstrap-admin: ${err instanceof Error ? err.message : 'error'}\n`);
    process.exit(1);
  });
}

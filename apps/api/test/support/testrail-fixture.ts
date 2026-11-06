/**
 * Fixture TestRail para pruebas de API-A: TestRail en memoria + conexión local aislada por prueba.
 * Datos sintéticos (sin casos reales).
 */
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createLogger } from '../../src/logger.js';
import { FakeTestRailClient } from '../../src/adapters/testrail/fake-client.js';
import type { SyncDeps } from '../../src/modules/testrail/sync.js';

export interface TrWorld {
  fake: FakeTestRailClient;
  projectId: number;
  suiteA: number;
  suiteB: number;
  root: number;
  child: number;
  other: number;
}

export function makeWorld(): TrWorld {
  const fake = new FakeTestRailClient(100_000 + Math.floor(Math.random() * 1_000_000) * 100);
  const p = fake.addProject('Proyecto sintético');
  const a = fake.addSuite(p.id, 'Suite A');
  const b = fake.addSuite(p.id, 'Suite B');
  const root = fake.addSection(a.id, 'Órdenes de carga');
  const child = fake.addSection(a.id, 'Distribuidores', root.id);
  const other = fake.addSection(b.id, 'Agendamientos');
  fake.addCase(root.id, 'Abrir órdenes de carga', {
    custom_steps_separated: [{ content: 'Ir a /loadOrder', expected: 'Se ve la grilla' }],
    custom_expected: 'Grilla visible',
  });
  fake.addCase(child.id, 'Cambiar a distribuidores', { custom_steps: 'Pulsar Distribuidores', refs: 'JIRA-1' });
  fake.addCase(child.id, 'Filtrar distribuidores', { custom_steps: 'Filtrar' });
  fake.addCase(other.id, 'Lista de agendamientos', { custom_steps: 'Abrir lista', custom_rare_field: 'x' });
  fake.addCase(other.id, 'Calendario de agendamientos', { custom_steps: 'Abrir calendario' });
  return { fake, projectId: p.id, suiteA: a.id, suiteB: b.id, root: root.id, child: child.id, other: other.id };
}

/** Crea una conexión TestRail propia de la prueba (las sync se acotan por connectionId). */
export async function createConnection(prisma: PrismaClient, projectExternalId: number, suiteExternalIds: number[] = []) {
  return prisma.testRailConnection.create({
    data: {
      baseUrl: `https://tr-${randomUUID().slice(0, 8)}.example.test`,
      username: 'servicio@example.test',
      secretRef: 'env:KATALYST_SECRET__TESTRAIL_API_KEY',
      projectExternalId,
      suiteExternalIds,
      enabled: true,
      // Antigüedad para no desplazar a la conexión "principal" de las rutas.
      createdAt: new Date(Date.now() + 3600_000),
    },
  });
}

export function syncDeps(prisma: PrismaClient, fake: FakeTestRailClient, businessFields: string[] = []): SyncDeps {
  return {
    prisma,
    logger: createLogger({ level: 'silent', service: 'test' }),
    clientFactory: async () => fake,
    businessFields,
  };
}

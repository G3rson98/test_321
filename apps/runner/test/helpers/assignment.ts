import { randomUUID } from 'node:crypto';
import { CHROMIUM_NO_THROTTLE_FLAGS, DEFAULT_PRODUCTION_ARTIFACT_POLICY, type AssignedTest, type ArtifactPolicy } from '@katalyst/shared';
import type { RunnerShardAssignment } from '../../src/worker-api/types.js';

export function assignedTest(stableKey: string, over: Partial<AssignedTest> = {}): AssignedTest {
  return {
    runResultId: randomUUID(),
    stableKey,
    file: 'tests/x.spec.ts',
    title: `T ${stableKey.slice(0, 4)}`,
    parameterKey: 'default',
    classification: 'lectura',
    retries: 0,
    writeIdempotencyApproved: false,
    nextAttemptNo: 1,
    nextAttemptKind: 'inicial',
    ...over,
  };
}

export const STAGING_POLICY: ArtifactPolicy = {
  enabledKinds: ['reporte', 'log', 'captura', 'traza', 'dxmon_samples', 'dxmon_summary'],
  screenshotsOnFailureOnly: true,
  videoOnFailureOnly: true,
  traceOnFailureOnly: true,
  maxEvidenceBytesPerRun: 250 * 1024 * 1024,
  maxTempBytesPerRun: 1024 * 1024 * 1024,
  retentionDays: 30,
  disabledReasons: {},
};

export function assignment(tests: AssignedTest[], over: Partial<RunnerShardAssignment> = {}): RunnerShardAssignment {
  return {
    runId: randomUUID(),
    shardId: randomUUID(),
    shardKey: 'shard-1',
    kind: 'funcional',
    gitCommit: 'a'.repeat(40),
    manifestHash: 'b'.repeat(64),
    tests,
    environment: { appUrl: 'http://127.0.0.1:1', apiUrl: 'http://127.0.0.1:1', isProduction: false, name: 'staging' },
    testUserRef: { testUserId: randomUUID(), username: 'qa.bot', secretRef: 'env:KATALYST_SECRET__QA_BOT_PASSWORD', readOnly: true },
    timeouts: { testMs: 120_000, setupMs: 120_000, runMs: 1_200_000, runDeadlineAt: new Date(Date.now() + 1_200_000).toISOString() },
    artifactPolicy: STAGING_POLICY,
    runtime: {
      playwrightVersion: '1.65.0',
      image: 'mcr.microsoft.com/playwright:v1.65.0-noble',
      imageDigest: null,
      browserConcurrency: 1,
      chromiumFlags: [...CHROMIUM_NO_THROTTLE_FLAGS],
    },
    ...over,
  };
}

export { DEFAULT_PRODUCTION_ARTIFACT_POLICY };

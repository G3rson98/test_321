/**
 * `GitPrProvider`: abre ramas nuevas y pull/merge requests en el repositorio de tests (plataforma pendiente ESP §12).
 * Reglas (ESP §13.1, §13.6, §13.7):
 * - Nunca escribe en la rama protegida ni fusiona: solo crea/actualiza ramas `katalyst/...` y abre PR/MR. La cuenta
 *   del token debe carecer de permiso de merge/bypass (configuración del repositorio, documentado en operación).
 * - Token por referencia de secreto; nunca en URL, argumentos de proceso ni mensajes de error.
 * - No ejecuta código del repositorio ni instala dependencias (sin hooks en el adaptador local).
 * RF-GRB-02, RF-GRB-03, RF-GRB-04, RF-GRB-05.
 */

export interface GitFile {
  /** Ruta relativa validada (sin traversal). */
  path: string;
  content: string;
}

export interface OpenChangeRequest {
  baseBranch: string;
  /** Rama nueva `katalyst/...` (se recrea desde la base si ya existía de un intento previo). */
  branch: string;
  commitMessage: string;
  files: GitFile[];
  title: string;
  body: string;
  /** Borrador: los hallazgos que bloquean aprobación se resuelven antes de marcar listo. */
  draft: boolean;
}

export interface ChangeResult {
  branch: string;
  commit: string;
  url: string;
  number: number | null;
}

export interface PushRequest {
  branch: string;
  commitMessage: string;
  files: GitFile[];
}

export interface GitPrProvider {
  readonly kind: 'github' | 'gitlab' | 'local';
  /** Contenido de `path` en `ref` (rama) o `null` si no existe. */
  readFile(ref: string, path: string): Promise<string | null>;
  openChange(req: OpenChangeRequest): Promise<ChangeResult>;
  /** Añade un commit sobre una rama `katalyst/...` existente (p. ej. revisión asistida). */
  pushToBranch(req: PushRequest): Promise<{ commit: string }>;
}

export class GitProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GitProviderError';
  }
}

export const KATALYST_BRANCH_RE = /^katalyst\/[a-z0-9][a-z0-9._/-]{0,180}$/;
const SAFE_PATH_RE = /^[A-Za-z0-9_\-./]+$/;

export function assertKatalystBranch(branch: string, protectedBranch?: string): void {
  if (!KATALYST_BRANCH_RE.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) {
    throw new GitProviderError('Nombre de rama no permitido');
  }
  if (protectedBranch && branch === protectedBranch) throw new GitProviderError('No se escribe en la rama protegida');
}

export function assertSafeRepoPath(path: string): void {
  if (
    !SAFE_PATH_RE.test(path) ||
    path.startsWith('/') ||
    path.split('/').some((s) => s === '..' || s === '' || s === '.') ||
    path.startsWith('.git')
  ) {
    throw new GitProviderError('Ruta de archivo no permitida');
  }
}

export function assertSafeRef(ref: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(ref) || ref.includes('..')) {
    throw new GitProviderError('Referencia Git no permitida');
  }
}

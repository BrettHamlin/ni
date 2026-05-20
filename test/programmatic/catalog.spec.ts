import type { Agent } from 'package-manager-detector'
import type { Runner } from '../../src/runner'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import prompts from '@posva/prompts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

vi.mock('tinyexec', () => ({
  x: vi.fn(async () => ({
    exitCode: 0,
    stdout: '',
  })),
}))

vi.mock('../../src/detect', () => ({
  detect: vi.fn(() => 'pnpm'),
}))

vi.mock('../../src/catalog/package-json', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/catalog/package-json')>()
  return {
    ...original,
    updatePackageJsonCatalogRefs: vi.fn(original.updatePackageJsonCatalogRefs),
  }
})

vi.mock('../../src/catalog/pnpm', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/catalog/pnpm')>()
  return {
    ...original,
    pnpmCatalogProvider: {
      ...original.pnpmCatalogProvider,
      addPackage: vi.fn(original.pnpmCatalogProvider.addPackage),
    },
  }
})

vi.mock('../../src/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/config')>()
  return {
    ...original,
    getConfig: vi.fn(async () => ({
      defaultAgent: 'pnpm',
      globalAgent: 'npm',
      runAgent: undefined,
      useSfw: false,
      catalog: true,
    })),
    getDefaultAgent: vi.fn(async () => 'pnpm'),
    getGlobalAgent: vi.fn(async () => 'npm'),
    getRunAgent: vi.fn(async () => undefined),
    getUseSfw: vi.fn(async () => false),
    getCatalog: vi.fn(async () => true),
  }
})

vi.mock('fast-npm-meta', () => ({
  getLatestVersion: vi.fn(async (name: string) => ({
    name,
    version: '1.0.0',
  })),
}))

vi.mock('@posva/prompts', () => ({
  default: vi.fn(async () => ({})),
}))

async function createTempDir(fixture: string): Promise<string> {
  const tmp = await fs.promises.mkdtemp(path.join(tmpdir(), 'ni-catalog-'))
  const fixtureDir = path.join(__dirname, '..', 'fixtures', 'catalog', fixture)
  await fs.promises.cp(fixtureDir, tmp, { recursive: true })
  return tmp
}

async function createNpmTempDir(): Promise<string> {
  const tmp = await fs.promises.mkdtemp(path.join(tmpdir(), 'ni-npm-preview-'))
  await fs.promises.writeFile(
    path.join(tmp, 'package.json'),
    `${JSON.stringify({ name: 'npm-preview', private: true, dependencies: {} }, null, 2)}\n`,
  )
  return tmp
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

function hashFile(filePath: string) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function getFileState(filePath: string) {
  if (!fs.existsSync(filePath))
    return { exists: false }

  const stat = fs.statSync(filePath)
  return {
    exists: true,
    hash: hashFile(filePath),
    mtimeMs: stat.mtimeMs,
  }
}

const niRunner: Runner = async (agent: Agent, args, ctx) => {
  const { handleCatalogInstall } = await import('../../src/catalog/handler')
  if (!args.includes('-g')) {
    const catalogCmd = await handleCatalogInstall(agent, args, ctx)
    if (catalogCmd !== undefined)
      return catalogCmd
  }

  const { parseNi } = await import('../../src/parse')
  return parseNi(agent, args, ctx)
}

async function runNi(args: string[], cwd: string) {
  const { run } = await import('../../src/runner')
  await run(niRunner, [...args], {
    cwd,
    detectVolta: false,
    programmatic: true,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ni preview mode contract', () => {
  it('threads the debug flag through run and strips ? before the runner', async () => {
    // harness:criterion=c-runner-context-debug-field,c-run-strips-question-sets-debug,c-no-debug-flag-without-question-mark
    const { run } = await import('../../src/runner')
    const captured: Array<{ args: string[], debug: boolean | undefined }> = []
    const runner: Runner = (agent, args, ctx) => {
      captured.push({ args: [...args], debug: ctx?.debug })
      return undefined
    }

    await run(runner, ['?', 'react'], { cwd: await createTempDir('pnpm'), programmatic: true })
    await run(runner, ['react'], { cwd: await createTempDir('pnpm'), programmatic: true })

    expect(captured[0].debug).toBe(true)
    expect(captured[0].args).toEqual(['react'])
    expect(captured[0].args).not.toContain('?')
    expect(captured[1].debug).toBeFalsy()
  })

  it('previews a named-catalog pnpm install without mutating files or spawning pnpm', async () => {
    // harness:criterion=c-catalog-preview-no-add-package,c-catalog-preview-no-update-package-json-refs,c-catalog-preview-no-workspace-yaml-mutation,c-catalog-preview-no-lockfile-mutation,c-catalog-preview-returns-command,c-catalog-preview-no-install-executed,c-handle-catalog-install-debug-flag-visible,c-preview-stdout-command-byte-preservation
    const cwd = await createTempDir('pnpm')
    const packageJsonPath = path.join(cwd, 'package.json')
    const workspacePath = path.join(cwd, 'pnpm-workspace.yaml')
    const lockfilePath = path.join(cwd, 'pnpm-lock.yaml')
    const beforePackageJson = hashFile(packageJsonPath)
    const beforeWorkspace = hashFile(workspacePath)
    const beforeLockfile = getFileState(lockfilePath)

    const { pnpmCatalogProvider } = await import('../../src/catalog/pnpm')
    const packageJsonModule = await import('../../src/catalog/package-json')
    const handlerModule = await import('../../src/catalog/handler')
    const { x } = await import('tinyexec')
    const handleSpy = vi.spyOn(handlerModule, 'handleCatalogInstall')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let logCalls: unknown[][] = []

    try {
      await runNi(['?', 'react'], cwd)
      logCalls = [...logSpy.mock.calls]
    }
    finally {
      logSpy.mockRestore()
    }

    expect(vi.mocked(pnpmCatalogProvider.addPackage)).toHaveBeenCalledTimes(0)
    expect(vi.mocked(packageJsonModule.updatePackageJsonCatalogRefs)).toHaveBeenCalledTimes(0)
    expect(hashFile(packageJsonPath)).toBe(beforePackageJson)
    expect(hashFile(workspacePath)).toBe(beforeWorkspace)
    expect(getFileState(lockfilePath)).toEqual(beforeLockfile)
    expect(logCalls).toHaveLength(1)
    expect(logCalls[0][0]).toBe('pnpm add react')
    expect(vi.mocked(x)).not.toHaveBeenCalled()
    expect(handleSpy).toHaveBeenCalled()
    expect(handleSpy.mock.calls[0][2]?.debug).toBe(true)
  })

  it('previews a default-only pnpm catalog install without writing catalog or package refs', async () => {
    // harness:criterion=c-catalog-preview-default-only-no-add-package,c-catalog-preview-default-only-no-workspace-yaml-mutation,c-catalog-preview-default-only-no-package-json-mutation,c-catalog-preview-default-only-returns-command
    const cwd = await createTempDir('pnpm-default-only')
    const packageJsonPath = path.join(cwd, 'package.json')
    const workspacePath = path.join(cwd, 'pnpm-workspace.yaml')
    const beforePackageJson = hashFile(packageJsonPath)
    const beforeWorkspace = hashFile(workspacePath)

    const { pnpmCatalogProvider } = await import('../../src/catalog/pnpm')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let logCalls: unknown[][] = []

    try {
      await runNi(['?', 'lodash'], cwd)
      logCalls = [...logSpy.mock.calls]
    }
    finally {
      logSpy.mockRestore()
    }

    expect(vi.mocked(pnpmCatalogProvider.addPackage)).toHaveBeenCalledTimes(0)
    expect(hashFile(packageJsonPath)).toBe(beforePackageJson)
    expect(hashFile(workspacePath)).toBe(beforeWorkspace)
    expect(logCalls).toHaveLength(1)
    expect(logCalls[0][0]).toBe('pnpm add lodash')
  })

  it('does not open an interactive catalog prompt while debugging', async () => {
    // harness:criterion=c-catalog-preview-no-interactive-prompt
    const cwd = await createTempDir('pnpm')
    const { pnpmCatalogProvider } = await import('../../src/catalog/pnpm')
    const { promptSelectCatalog } = await import('../../src/catalog/prompt')
    const config = await pnpmCatalogProvider.detect(cwd)
    const stdinReadSpy = vi.spyOn(process.stdin, 'read').mockImplementation(() => {
      throw new Error('stdin was read')
    })

    try {
      const started = Date.now()
      const result = await Promise.race([
        promptSelectCatalog(config!, 'lodash', { debug: true }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('prompt timed out')), 100)),
      ])

      expect(Date.now() - started).toBeLessThan(100)
      expect(result.catalogName).toBeUndefined()
      expect(stdinReadSpy).not.toHaveBeenCalled()
      expect(vi.mocked(prompts)).not.toHaveBeenCalled()
    }
    finally {
      stdinReadSpy.mockRestore()
    }
  })

  it('previews an npm non-catalog install without file writes or child process execution', async () => {
    // harness:criterion=c-npm-non-catalog-preview-no-package-json-mutation,c-npm-non-catalog-preview-no-lockfile-mutation,c-npm-non-catalog-preview-no-install-executed,c-npm-non-catalog-preview-returns-command
    const cwd = await createNpmTempDir()
    const packageJsonPath = path.join(cwd, 'package.json')
    const lockfilePath = path.join(cwd, 'package-lock.json')
    const beforePackageJson = hashFile(packageJsonPath)
    const beforeLockfile = getFileState(lockfilePath)
    const { detect } = await import('../../src/detect')
    const { x } = await import('tinyexec')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let logCalls: unknown[][] = []
    vi.mocked(detect).mockResolvedValueOnce('npm')

    try {
      await runNi(['?', 'react'], cwd)
      logCalls = [...logSpy.mock.calls]
    }
    finally {
      logSpy.mockRestore()
    }

    expect(hashFile(packageJsonPath)).toBe(beforePackageJson)
    expect(getFileState(lockfilePath)).toEqual(beforeLockfile)
    expect(logCalls).toHaveLength(1)
    expect(logCalls[0][0]).toBe('npm i react')
    expect(vi.mocked(x)).not.toHaveBeenCalled()
  })

  it('keeps normal pnpm catalog installs mutating package refs and catalog files', async () => {
    // harness:criterion=c-catalog-normal-install-mutates-workspace-yaml,c-catalog-normal-install-mutates-package-json,c-catalog-normal-install-calls-add-package
    const namedCwd = await createTempDir('pnpm')
    const namedPackageJsonPath = path.join(namedCwd, 'package.json')
    const beforeNamedPackageJson = hashFile(namedPackageJsonPath)
    const packageJsonModule = await import('../../src/catalog/package-json')

    await runNi(['react'], namedCwd)

    const namedPkg = readJson(namedPackageJsonPath)
    expect(vi.mocked(packageJsonModule.updatePackageJsonCatalogRefs)).toHaveBeenCalled()
    expect(hashFile(namedPackageJsonPath)).not.toBe(beforeNamedPackageJson)
    expect(namedPkg.dependencies.react).toBe('catalog:prod')

    const defaultOnlyCwd = await createTempDir('pnpm-default-only')
    const workspacePath = path.join(defaultOnlyCwd, 'pnpm-workspace.yaml')
    const beforeWorkspace = hashFile(workspacePath)
    const { pnpmCatalogProvider } = await import('../../src/catalog/pnpm')

    await runNi(['lodash'], defaultOnlyCwd)

    const workspaceContent = fs.readFileSync(workspacePath, 'utf-8')
    expect(vi.mocked(pnpmCatalogProvider.addPackage)).toHaveBeenCalled()
    expect(hashFile(workspacePath)).not.toBe(beforeWorkspace)
    expect(workspaceContent).toContain('lodash')
  })
})

describe('catalog handler - named catalogs', () => {
  it('package found in catalog → updates package.json, returns pnpm install', async () => {
    const cwd = await createTempDir('pnpm')
    const { handleCatalogInstall } = await import('../../src/catalog/handler')

    const result = await handleCatalogInstall('pnpm', ['react'], { cwd, programmatic: true })

    expect(result).toBeDefined()
    expect(result!.command).toBe('pnpm')
    expect(result!.args).toEqual(['i'])

    const pkg = readJson(path.join(cwd, 'package.json'))
    expect(pkg.dependencies.react).toBe('catalog:prod')
  })

  it('multiple packages in different catalogs', async () => {
    const cwd = await createTempDir('pnpm')
    const { handleCatalogInstall } = await import('../../src/catalog/handler')

    const result = await handleCatalogInstall('pnpm', ['react', 'typescript'], { cwd, programmatic: true })

    expect(result).toBeDefined()
    expect(result!.command).toBe('pnpm')
    expect(result!.args).toEqual(['i'])

    const pkg = readJson(path.join(cwd, 'package.json'))
    expect(pkg.dependencies.react).toBe('catalog:prod')
    expect(pkg.dependencies.typescript).toBe('catalog:dev')
  })

  it('-D flag → writes to devDependencies', async () => {
    const cwd = await createTempDir('pnpm')
    const { handleCatalogInstall } = await import('../../src/catalog/handler')

    const result = await handleCatalogInstall('pnpm', ['react', '-D'], { cwd, programmatic: true })

    expect(result).toBeDefined()
    const pkg = readJson(path.join(cwd, 'package.json'))
    expect(pkg.devDependencies.react).toBe('catalog:prod')
    expect(pkg.dependencies?.react).toBeUndefined()
  })

  it('unknown package in programmatic mode → skips catalog', async () => {
    const cwd = await createTempDir('pnpm')
    const { handleCatalogInstall } = await import('../../src/catalog/handler')

    const result = await handleCatalogInstall('pnpm', ['unknown-pkg'], { cwd, programmatic: true })

    // In programmatic mode, unknown packages are skipped → falls through
    expect(result).toBeUndefined()
  })

  it('mixed known/unknown packages in programmatic mode', async () => {
    const cwd = await createTempDir('pnpm')
    const { handleCatalogInstall } = await import('../../src/catalog/handler')

    const result = await handleCatalogInstall('pnpm', ['react', 'unknown-pkg'], { cwd, programmatic: true })

    // react is cataloged, unknown-pkg is skipped → add command for skipped ones
    expect(result).toBeDefined()
    expect(result!.command).toBe('pnpm')
    expect(result!.args).toContain('unknown-pkg')

    const pkg = readJson(path.join(cwd, 'package.json'))
    expect(pkg.dependencies.react).toBe('catalog:prod')
  })
})

describe('catalog handler - default catalog only', () => {
  it('package found → uses catalog: ref (no name)', async () => {
    const cwd = await createTempDir('pnpm-default-only')
    const { handleCatalogInstall } = await import('../../src/catalog/handler')

    const result = await handleCatalogInstall('pnpm', ['react'], { cwd, programmatic: true })

    expect(result).toBeDefined()
    expect(result!.args).toEqual(['i'])

    const pkg = readJson(path.join(cwd, 'package.json'))
    expect(pkg.dependencies.react).toBe('catalog:')
  })

  it('new package → adds to default catalog without prompt', async () => {
    const cwd = await createTempDir('pnpm-default-only')
    const { handleCatalogInstall } = await import('../../src/catalog/handler')

    const result = await handleCatalogInstall('pnpm', ['lodash'], { cwd, programmatic: true })

    expect(result).toBeDefined()
    expect(result!.args).toEqual(['i'])

    // Check workspace yaml was updated
    const yamlContent = fs.readFileSync(path.join(cwd, 'pnpm-workspace.yaml'), 'utf-8')
    expect(yamlContent).toContain('lodash')

    // Check package.json uses catalog:
    const pkg = readJson(path.join(cwd, 'package.json'))
    expect(pkg.dependencies.lodash).toBe('catalog:')
  })
})

describe('catalog handler - skip conditions', () => {
  it('returns undefined for non-pnpm agent', async () => {
    const cwd = await createTempDir('pnpm')
    const { handleCatalogInstall } = await import('../../src/catalog/handler')

    const result = await handleCatalogInstall('npm', ['react'], { cwd, programmatic: true })
    expect(result).toBeUndefined()
  })

  it('returns undefined when no packages in args (bare install)', async () => {
    const cwd = await createTempDir('pnpm')
    const { handleCatalogInstall } = await import('../../src/catalog/handler')

    const result = await handleCatalogInstall('pnpm', [], { cwd, programmatic: true })
    expect(result).toBeUndefined()
  })

  it('returns undefined when only flags', async () => {
    const cwd = await createTempDir('pnpm')
    const { handleCatalogInstall } = await import('../../src/catalog/handler')

    const result = await handleCatalogInstall('pnpm', ['--frozen'], { cwd, programmatic: true })
    expect(result).toBeUndefined()
  })

  it('returns undefined when catalog config disabled', async () => {
    const { getCatalog } = await import('../../src/config')
    vi.mocked(getCatalog).mockResolvedValueOnce(false)

    const cwd = await createTempDir('pnpm')
    const { handleCatalogInstall } = await import('../../src/catalog/handler')

    const result = await handleCatalogInstall('pnpm', ['react'], { cwd, programmatic: true })
    expect(result).toBeUndefined()
  })
})

describe('catalog handler - subdirectory', () => {
  it('finds closest package.json from subdirectory', async () => {
    const cwd = await createTempDir('pnpm')
    const subDir = path.join(cwd, 'packages', 'app')

    const { handleCatalogInstall } = await import('../../src/catalog/handler')
    const result = await handleCatalogInstall('pnpm', ['react'], { cwd: subDir, programmatic: true })

    expect(result).toBeDefined()

    // Should write to the subdirectory's package.json (closest)
    const pkg = readJson(path.join(subDir, 'package.json'))
    expect(pkg.dependencies.react).toBe('catalog:prod')
  })

  it('-w flag targets workspace root package.json', async () => {
    const cwd = await createTempDir('pnpm')
    const subDir = path.join(cwd, 'packages', 'app')

    const { handleCatalogInstall } = await import('../../src/catalog/handler')
    const result = await handleCatalogInstall('pnpm', ['react', '-w'], { cwd: subDir, programmatic: true })

    expect(result).toBeDefined()

    // Should write to root package.json, not subdirectory
    const rootPkg = readJson(path.join(cwd, 'package.json'))
    expect(rootPkg.dependencies.react).toBe('catalog:prod')

    // Subdirectory package.json should be unchanged
    const subPkg = readJson(path.join(subDir, 'package.json'))
    expect(subPkg.dependencies.react).toBeUndefined()
  })
})

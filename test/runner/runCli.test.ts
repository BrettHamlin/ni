import type { Runner } from '../../src'
import fs from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { run, runCli } from '../../src'

// Mock detect to see what options are passed to it
const mocks = vi.hoisted(() => ({
  detectSpy: vi.fn(() => Promise.resolve('npm')),
  baseRunFnSpy: vi.fn<Runner>(() => Promise.resolve(undefined)),
  xSpy: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('../../src/detect', () => ({
  detect: mocks.detectSpy,
}))
vi.mock('tinyexec', async (importOriginal) => {
  const mod = await importOriginal<typeof import('tinyexec')>()
  return {
    ...mod,
    x: mocks.xSpy,
  }
})
vi.mock('which', () => ({
  default: {
    sync: vi.fn(() => null),
  },
}))

describe('runCli', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('run without errors', async () => {
    const result = await runCli(mocks.baseRunFnSpy, {})
    expect(result).toBe(undefined)
  })

  it('handle errors in programmatic mode', async () => {
    await expect(
      runCli(() => {
        throw new Error('test error')
      }, { programmatic: true }),
    ).rejects.toThrow('test error')
  })

  it('calls detect with the correct options', async () => {
    await runCli(mocks.baseRunFnSpy)
    expect(mocks.detectSpy).toHaveBeenCalledWith(({ autoInstall: false, programmatic: false, cwd: expect.any(String) }))
  })

  it('detects environment options', async () => {
    vi.stubEnv('NI_AUTO_INSTALL', 'true')
    await runCli(mocks.baseRunFnSpy)
    expect(mocks.detectSpy).toHaveBeenCalledWith({ autoInstall: true, programmatic: false, cwd: expect.any(String) })
  })

  it('accepts options as input', async () => {
    await runCli(mocks.baseRunFnSpy, { autoInstall: true, programmatic: true })
    expect(mocks.detectSpy).toHaveBeenCalledWith({ autoInstall: true, programmatic: true, cwd: expect.any(String) })
  })

  it('merges inputs and environment prioritizing inputs', async () => {
    vi.stubEnv('NI_AUTO_INSTALL', 'true')
    await runCli(mocks.baseRunFnSpy, { autoInstall: false, programmatic: true })
    expect(mocks.detectSpy).toHaveBeenCalledWith({ autoInstall: false, programmatic: true, cwd: expect.any(String) })
  })

  it('parses --programmatic flag from args', async () => {
    await runCli(mocks.baseRunFnSpy, { args: ['--programmatic'] })
    expect(mocks.detectSpy).toHaveBeenCalledWith(expect.objectContaining({ autoInstall: false, programmatic: true, cwd: expect.any(String) }))
  })

  it('removes --programmatic from args before passing to runner', async () => {
    await runCli(mocks.baseRunFnSpy, { args: ['--programmatic', 'foo'] })
    expect(mocks.baseRunFnSpy).toHaveBeenCalledWith('npm', ['foo'], { programmatic: true, hasLock: true, cwd: expect.any(String) })
  })

  it('removes --dry-run from args before passing to runner', async () => {
    //harness:criterion=c-dry-run-stripped-from-args
    const parserSpy = vi.fn<Runner>(() => undefined)

    await run(parserSpy, ['--dry-run', 'lodash'], { programmatic: true })

    expect(parserSpy).toHaveBeenCalledOnce()
    expect(parserSpy.mock.calls[0][1]).not.toContain('--dry-run')
    expect(parserSpy.mock.calls[0][1]).toEqual(['lodash'])
  })

  it('preserves --dry-run after positional args as a forwarded arg', async () => {
    const parserSpy = vi.fn<Runner>(() => undefined)

    await run(parserSpy, ['lodash', '--dry-run'], { programmatic: true })

    expect(parserSpy).toHaveBeenCalledOnce()
    expect(parserSpy.mock.calls[0][1]).toEqual(['lodash', '--dry-run'])
    expect(parserSpy.mock.calls[0][2]?.dryRun).toBeFalsy()
  })

  it('preserves --dry-run after -- as a forwarded arg', async () => {
    const parserSpy = vi.fn<Runner>(() => undefined)

    await run(parserSpy, ['--', '--dry-run'], { programmatic: true })

    expect(parserSpy).toHaveBeenCalledOnce()
    expect(parserSpy.mock.calls[0][1]).toEqual(['--', '--dry-run'])
    expect(parserSpy.mock.calls[0][2]?.dryRun).toBeFalsy()
  })

  it('continues to remove ? from args before passing to runner', async () => {
    //harness:criterion=c-question-mark-still-stripped
    const parserSpy = vi.fn<Runner>(() => undefined)

    await run(parserSpy, ['?', 'lodash'], { programmatic: true })

    expect(parserSpy).toHaveBeenCalledOnce()
    expect(parserSpy.mock.calls[0][1]).not.toContain('?')
    expect(parserSpy.mock.calls[0][1]).toEqual(['lodash'])
  })

  it('sets preview mode for --dry-run without executing the command', async () => {
    //harness:criterion=c-dry-run-sets-debug-flag
    const logSpy = vi.spyOn(console, 'log')
    const parserSpy = vi.fn<Runner>((_, args) => ({ command: 'npm', args: ['i', ...args] }))

    await run(parserSpy, ['--dry-run', 'lodash'], { programmatic: true })
    const dryRunOutput = logSpy.mock.calls.at(-1)?.[0]
    expect(mocks.xSpy).not.toHaveBeenCalled()

    logSpy.mockClear()
    mocks.xSpy.mockClear()

    await run(parserSpy, ['?', 'lodash'], { programmatic: true })
    const questionMarkOutput = logSpy.mock.calls.at(-1)?.[0]

    expect(dryRunOutput).toBe('npm i lodash')
    expect(questionMarkOutput).toBe('npm i lodash')
    expect(mocks.xSpy).not.toHaveBeenCalled()
  })

  it('exposes dryRun on runner context only for preview invocations', async () => {
    //harness:criterion=c-runner-context-dry-run-field
    const contextSpy = vi.fn<Runner>(() => undefined)

    await run(contextSpy, ['--dry-run', 'lodash'], { programmatic: true })
    expect(contextSpy.mock.calls[0][2]?.dryRun).toBe(true)

    contextSpy.mockClear()

    await run(contextSpy, ['?', 'lodash'], { programmatic: true })
    expect(contextSpy.mock.calls[0][2]?.dryRun).toBe(true)

    contextSpy.mockClear()

    await run(contextSpy, ['lodash'], { programmatic: true })
    expect(contextSpy.mock.calls[0][2]?.dryRun).toBeFalsy()
  })

  it('exposes dryRun on the pre-command context before parser execution', async () => {
    //harness:criterion=c-runner-context-dry-run-field
    const onBeforeCommand = vi.fn((_args: string[], ctx: { dryRun?: boolean, exit: () => void }) => ctx.exit())

    await run(mocks.baseRunFnSpy, ['--dry-run', 'lodash'], {
      programmatic: true,
      onBeforeCommand,
    })
    expect(onBeforeCommand.mock.calls[0][1].dryRun).toBe(true)

    onBeforeCommand.mockClear()

    await run(mocks.baseRunFnSpy, ['?', 'lodash'], {
      programmatic: true,
      onBeforeCommand,
    })
    expect(onBeforeCommand.mock.calls[0][1].dryRun).toBe(true)

    onBeforeCommand.mockClear()

    await run(mocks.baseRunFnSpy, ['lodash'], {
      programmatic: true,
      onBeforeCommand,
    })
    expect(onBeforeCommand.mock.calls[0][1].dryRun).toBeFalsy()
  })

  it('preserves args that only start with --dry-run', async () => {
    //harness:criterion=c-dry-run-value-byte-preserved
    const parserSpy = vi.fn<Runner>(() => undefined)

    await run(parserSpy, ['--dry-run-mode', 'lodash'], { programmatic: true })

    expect(parserSpy).toHaveBeenCalledOnce()
    expect(parserSpy.mock.calls[0][1]).toContain('--dry-run-mode')
    expect(parserSpy.mock.calls[0][1]).not.toContain('--dry-run')
  })

  it('does not enter preview mode for args that only start with --dry-run', async () => {
    //harness:criterion=c-dry-run-value-byte-preserved,c-runner-context-dry-run-field
    const logSpy = vi.spyOn(console, 'log')
    const parserSpy = vi.fn<Runner>((_, args) => ({ command: 'npm', args: ['i', ...args] }))

    await run(parserSpy, ['--dry-run-mode', 'lodash'], { programmatic: true })

    expect(parserSpy).toHaveBeenCalledOnce()
    expect(parserSpy.mock.calls[0][1]).toEqual(['--dry-run-mode', 'lodash'])
    expect(parserSpy.mock.calls[0][2]?.dryRun).toBeFalsy()
    expect(logSpy).not.toHaveBeenCalledWith('npm i --dry-run-mode lodash')
    expect(mocks.xSpy).toHaveBeenCalledOnce()
    expect(mocks.xSpy).toHaveBeenCalledWith(
      'npm',
      ['i', '--dry-run-mode', 'lodash'],
      expect.objectContaining({
        nodeOptions: expect.objectContaining({
          stdio: 'inherit',
        }),
        throwOnError: true,
      }),
    )
  })

  it('removes --dry-run after top-level -C before passing args and context to the runner', async () => {
    //harness:criterion=c-dry-run-stripped-from-args,c-runner-context-dry-run-field
    const parserSpy = vi.fn<Runner>(() => undefined)

    await run(parserSpy, ['-C', 'packages/app', '--dry-run', 'lodash'], {
      programmatic: true,
      cwd: '/tmp/project',
    })

    expect(parserSpy).toHaveBeenCalledOnce()
    expect(parserSpy.mock.calls[0][1]).toEqual(['lodash'])
    expect(parserSpy.mock.calls[0][1]).not.toContain('--dry-run')
    expect(parserSpy.mock.calls[0][2]?.dryRun).toBe(true)
    expect(parserSpy.mock.calls[0][2]?.cwd).toBe('/tmp/project/packages/app')
  })

  it('does not mutate catalog files during dry-run installs', async () => {
    //harness:criterion=c-ni-dry-run-no-file-mutation
    vi.resetModules()

    const addPackage = vi.fn()
    const updatePackageJsonCatalogRefs = vi.fn()
    const getLatestVersion = vi.fn(async () => ({ version: '1.0.0' }))
    const provider = {
      detect: vi.fn(async () => ({
        filePath: '/tmp/project/pnpm-workspace.yaml',
        catalogs: [],
        hasDefaultCatalog: true,
        hasNamedCatalogs: false,
      })),
      findPackage: vi.fn(() => undefined),
      addPackage,
    }

    vi.doMock('../../src/config', () => ({
      getConfig: vi.fn(async () => ({ catalog: true, noLastCommand: false, runAgent: undefined, useSfw: false })),
      getCatalog: vi.fn(async () => true),
      getDefaultAgent: vi.fn(async () => 'npm'),
      getGlobalAgent: vi.fn(async () => 'npm'),
      getRunAgent: vi.fn(async () => undefined),
      getUseSfw: vi.fn(async () => false),
    }))
    vi.doMock('../../src/catalog/detect', () => ({
      getCatalogProvider: vi.fn(() => provider),
    }))
    vi.doMock('../../src/catalog/package-json', () => ({
      findClosestPackageJson: vi.fn(() => '/tmp/project/package.json'),
      updatePackageJsonCatalogRefs,
    }))
    const promptSelectCatalog = vi.fn(async () => ({ catalogName: 'default' }))

    vi.doMock('../../src/catalog/prompt', () => ({
      promptSelectCatalog,
    }))
    vi.doMock('fast-npm-meta', () => ({
      getLatestVersion,
    }))

    const { handleCatalogInstall } = await import('../../src/catalog/handler')

    const result = await handleCatalogInstall('pnpm', ['lodash'], {
      dryRun: true,
      programmatic: true,
      cwd: '/tmp/project',
    })

    expect(result).toBeUndefined()
    expect(promptSelectCatalog).toHaveBeenCalledTimes(0)
    expect(addPackage).toHaveBeenCalledTimes(0)
    expect(updatePackageJsonCatalogRefs).toHaveBeenCalledTimes(0)
    expect(getLatestVersion).toHaveBeenCalledTimes(0)

    vi.doUnmock('../../src/config')
    vi.doUnmock('../../src/catalog/detect')
    vi.doUnmock('../../src/catalog/package-json')
    vi.doUnmock('../../src/catalog/prompt')
    vi.doUnmock('fast-npm-meta')
  })

  it('does not write nr last-run storage during dry-run', async () => {
    //harness:criterion=c-nr-dry-run-no-last-run-write
    vi.resetModules()

    const storage: { lastRunCommand?: string } = {}
    const dump = vi.fn()
    const runCliSpy = vi.fn()

    vi.doMock('../../src/runner', () => ({
      runCli: runCliSpy,
    }))
    vi.doMock('../../src/storage', () => ({
      load: vi.fn(async () => storage),
      dump,
    }))
    vi.doMock('../../src/config', () => ({
      getConfig: vi.fn(async () => ({ noLastCommand: false })),
      getCatalog: vi.fn(async () => false),
      getDefaultAgent: vi.fn(async () => 'npm'),
      getGlobalAgent: vi.fn(async () => 'npm'),
      getRunAgent: vi.fn(async () => undefined),
      getUseSfw: vi.fn(async () => false),
    }))

    await import('../../src/commands/nr')
    const nrHandler = runCliSpy.mock.calls[0][0] as Runner

    await nrHandler('npm', ['test'], {
      dryRun: true,
      programmatic: true,
      cwd: '/tmp/project',
    })

    expect(storage.lastRunCommand).toBeUndefined()
    expect(dump).toHaveBeenCalledTimes(0)

    vi.doUnmock('../../src/runner')
    vi.doUnmock('../../src/storage')
    vi.doUnmock('../../src/config')
  })

  it('documents --dry-run usage in the README', async () => {
    //harness:criterion=c-readme-documents-dry-run
    const readme = await fs.readFile(new URL('../../README.md', import.meta.url), 'utf-8')

    expect(readme).toContain('--dry-run')
    expect(readme).toMatch(/n[irud].*--dry-run|--dry-run.*n[irud]/)
  })

  describe('onBeforeCommand', () => {
    it('skips running the command when exit() is called', async () => {
      await runCli(mocks.baseRunFnSpy, { onBeforeCommand: (_args, ctx) => ctx.exit() })
      expect(mocks.baseRunFnSpy).not.toHaveBeenCalled()
      // https://github.com/antfu-collective/ni/issues/308
      expect(mocks.detectSpy).not.toHaveBeenCalled()
    })

    it('continues to run the command when exit() is not called', async () => {
      await runCli(mocks.baseRunFnSpy, { onBeforeCommand: () => Promise.resolve() })
      expect(mocks.baseRunFnSpy).toHaveBeenCalledOnce()
    })
  })
})

import type { MockInstance } from 'vitest'
import type { Runner } from '../../src'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AGENTS, parseNa, parseNd, parseNi, parseNlx, parseNr, parseNun, parseNup, runCli } from '../../src'

let basicLog: MockInstance, errorLog: MockInstance, warnLog: MockInstance, infoLog: MockInstance

const tinyexecMocks = vi.hoisted(() => ({
  x: vi.fn((cmd: string, args?: string[]) => {
    // break execution flow for easier snapshotting
    // eslint-disable-next-line no-throw-literal
    throw { command: [cmd, ...(args ?? [])].join(' ') }
  }),
}))

vi.mock('tinyexec', async (importOriginal) => {
  const mod = await importOriginal<typeof import('tinyexec')>()
  return {
    ...mod,
    x: tinyexecMocks.x,
  }
})
vi.mock('which', () => ({
  default: {
    sync: vi.fn(() => null),
  },
}))

function runCliTest(fixtureName: string, agent: string, runner: Runner, args: string[]) {
  return async () => {
    const cwd = await fs.mkdtemp(path.join(tmpdir(), 'ni-'))
    const fixture = path.join(__dirname, '..', 'fixtures', fixtureName, agent)
    await fs.cp(fixture, cwd, { recursive: true })

    await runCli(
      async (agent, _, ctx) => {
        // we override the args to be test specific
        return runner(agent, args, ctx)
      },
      {
        programmatic: true,
        cwd,
        args,
      },
    ).catch((e) => {
      // it will always throw if ezspawn is mocked
      if (e.command)
        expect(e.command).toMatchSnapshot()
      else
        expect(e.message).toMatchSnapshot()
    })
  }
}

beforeAll(() => {
  basicLog = vi.spyOn(console, 'log')
  warnLog = vi.spyOn(console, 'warn')
  errorLog = vi.spyOn(console, 'error')
  infoLog = vi.spyOn(console, 'info')
})

afterAll(() => {
  vi.resetAllMocks()
})

const agents = [...AGENTS, 'unknown']
const fixtures = ['lockfile', 'packager']
const skippedAgents: string[] = []

// matrix testing of: fixtures x agents x commands
fixtures.forEach(fixture => describe(fixture, () => agents.forEach(agent => describe(agent, () => {
  if (skippedAgents.includes(agent))
    return it.skip(`skipped for ${agent}`, () => {})

  /** na */
  it('na', runCliTest(fixture, agent, parseNa, []))
  it('na run foo', runCliTest(fixture, agent, parseNa, ['run', 'foo']))

  /** ni */
  it('ni', runCliTest(fixture, agent, parseNi, []))
  it('ni foo', runCliTest(fixture, agent, parseNi, ['foo']))
  it('ni foo -D', runCliTest(fixture, agent, parseNi, ['foo', '-D']))
  it('ni --frozen', runCliTest(fixture, agent, parseNi, ['--frozen']))
  it('ni -g foo', runCliTest(fixture, agent, parseNi, ['-g', 'foo']))

  /** nlx */
  it('nlx', runCliTest(fixture, agent, parseNlx, ['foo']))

  /** nup */
  it('nup', runCliTest(fixture, agent, parseNup, []))
  it('nup -i', runCliTest(fixture, agent, parseNup, ['-i']))

  /** nun */
  it('nun foo', runCliTest(fixture, agent, parseNun, ['foo']))
  it('nun -g foo', runCliTest(fixture, agent, parseNun, ['-g', 'foo']))

  it('no logs', () => {
    expect(basicLog).not.toHaveBeenCalled()
    expect(warnLog).not.toHaveBeenCalled()
    expect(errorLog).not.toHaveBeenCalled()
    expect(infoLog).not.toHaveBeenCalled()
  })
}))))

// https://github.com/antfu-collective/ni/issues/266
describe('debug mode', () => {
  beforeAll(() => basicLog.mockClear())

  it('ni', runCliTest('lockfile', 'npm', parseNi, ['@antfu/ni', '?']))
  it('should return command results in plain text format', () => {
    expect(basicLog).toHaveBeenCalled()

    expect(basicLog.mock.calls[0][0]).toMatchSnapshot()
  })
})

async function runPreview(fixtureName: string, agent: string, runner: Runner, args: string[]) {
  const logSpy = vi.spyOn(console, 'log')
  logSpy.mockClear()
  tinyexecMocks.x.mockClear()

  const cwd = await fs.mkdtemp(path.join(tmpdir(), 'ni-'))
  const fixture = path.join(__dirname, '..', 'fixtures', fixtureName, agent)
  await fs.cp(fixture, cwd, { recursive: true })

  await runCli(runner, {
    programmatic: true,
    cwd,
    args,
  })

  expect(logSpy).toHaveBeenCalledTimes(1)
  expect(tinyexecMocks.x).toHaveBeenCalledTimes(0)

  const output = logSpy.mock.calls[0][0]
  expect(typeof output).toBe('string')
  expect(output.length).toBeGreaterThan(0)
  return output as string
}

describe('dry-run preview mode', () => {
  beforeEach(() => {
    basicLog.mockClear()
    tinyexecMocks.x.mockClear()
  })

  const commandCases: {
    name: string
    runner: Runner
    args: string[]
    expected: Record<'npm' | 'pnpm', RegExp>
  }[] = [
    {
      name: 'ni',
      runner: parseNi,
      args: [],
      expected: {
        npm: /^npm (i|install)$/,
        pnpm: /^pnpm (i|install)$/,
      },
    },
    {
      name: 'nr',
      runner: parseNr,
      args: ['test'],
      expected: {
        npm: /^npm run test$/,
        pnpm: /^pnpm run test$/,
      },
    },
    {
      name: 'nup',
      runner: parseNup,
      args: [],
      expected: {
        npm: /^npm update$/,
        pnpm: /^pnpm update$/,
      },
    },
    {
      name: 'nlx',
      runner: parseNlx,
      args: ['some-pkg'],
      expected: {
        npm: /^npx some-pkg$/,
        pnpm: /^pnpm dlx some-pkg$/,
      },
    },
    {
      name: 'nun',
      runner: parseNun,
      args: ['lodash'],
      expected: {
        npm: /^npm (uninstall|remove) lodash$/,
        pnpm: /^pnpm (remove|uninstall) lodash$/,
      },
    },
    {
      name: 'na',
      runner: parseNa,
      args: [],
      expected: {
        npm: /^npm$/,
        pnpm: /^pnpm$/,
      },
    },
    {
      name: 'nd',
      runner: parseNd,
      args: [],
      expected: {
        npm: /^npm dedupe$/,
        pnpm: /^pnpm dedupe$/,
      },
    },
  ]

  for (const agent of ['npm', 'pnpm'] as const) {
    for (const commandCase of commandCases) {
      it(`${commandCase.name} ${agent} --dry-run matches ? output`, async () => {
        //harness:criterion=c-dry-run-output-matches-question-mark-output,c-dry-run-no-execution-side-effects,c-dry-run-not-forwarded-to-pm,c-dry-run-console-log-spy
        //harness:criterion=c-ni-dry-run-prints-command,c-ni-question-mark-prints-command,c-nr-dry-run-prints-command,c-nr-question-mark-prints-command,c-pnpm-install-dry-run-prints-command,c-pnpm-run-dry-run-prints-command,c-nup-dry-run-prints-command,c-nlx-dry-run-prints-command,c-nun-dry-run-prints-command,c-na-dry-run-prints-command,c-nd-dry-run-prints-command
        const dryRunOutput = await runPreview('lockfile', agent, commandCase.runner, ['--dry-run', ...commandCase.args])
        const questionMarkOutput = await runPreview('lockfile', agent, commandCase.runner, ['?', ...commandCase.args])

        expect(dryRunOutput).toBe(questionMarkOutput)
        expect(dryRunOutput).toMatch(commandCase.expected[agent])
        expect(dryRunOutput).not.toContain('--dry-run')
      })
    }
  }

  for (const agent of ['npm', 'pnpm'] as const) {
    for (const commandCase of commandCases.slice(0, 2)) {
      it(`${commandCase.name} ${agent} --dry-run snapshots match ? snapshots`, async () => {
        //harness:criterion=c-dry-run-snapshot-matches
        const dryRunOutput = await runPreview('lockfile', agent, commandCase.runner, ['--dry-run', ...commandCase.args])
        const questionMarkOutput = await runPreview('lockfile', agent, commandCase.runner, ['?', ...commandCase.args])

        expect(dryRunOutput).toBe(questionMarkOutput)
        expect(dryRunOutput).toMatchSnapshot()
        expect(questionMarkOutput).toMatchSnapshot()
      })
    }
  }
})

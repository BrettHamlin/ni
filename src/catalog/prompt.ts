import type { RunnerContext } from '../runner'
import type { CatalogConfig } from './types'
import { styleText } from 'node:util'
import prompts from '@posva/prompts'

const SKIP = '__skip__'
const CREATE_NEW = '__create_new__'

export interface CatalogSelection {
  catalogName: string | undefined
}

export async function promptSelectCatalog(
  config: CatalogConfig,
  pkgName: string,
  ctxOrProgrammatic?: Pick<RunnerContext, 'debug' | 'programmatic'> | boolean,
): Promise<CatalogSelection> {
  const ctx = typeof ctxOrProgrammatic === 'boolean'
    ? { programmatic: ctxOrProgrammatic }
    : ctxOrProgrammatic

  // Only default catalog: no prompt needed
  if (config.hasDefaultCatalog && !config.hasNamedCatalogs) {
    return { catalogName: 'default' }
  }

  if (ctx?.debug || ctx?.programmatic) {
    return { catalogName: undefined }
  }

  const catalogChoices = config.catalogs.map(c => ({
    title: c.name,
    value: c.name,
  }))

  const { catalog } = await prompts({
    type: 'select',
    name: 'catalog',
    message: `select catalog for ${styleText('yellow', pkgName)}`,
    choices: [
      ...catalogChoices,
      { title: styleText('dim', 'create new catalog'), value: CREATE_NEW },
      { title: styleText('dim', 'skip (install without catalog)'), value: SKIP },
    ],
  })

  if (catalog === undefined || catalog === SKIP) {
    return { catalogName: undefined }
  }

  if (catalog === CREATE_NEW) {
    const newName = await promptNewCatalogName()
    return { catalogName: newName }
  }

  return { catalogName: catalog }
}

async function promptNewCatalogName(): Promise<string | undefined> {
  const { name } = await prompts({
    type: 'text',
    name: 'name',
    message: 'new catalog name',
  })
  return name || undefined
}

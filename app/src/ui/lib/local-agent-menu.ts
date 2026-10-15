import {
  getLocalAgent,
  getRecentLocalAgents,
  ILocalAgent,
  ILocalAgentModel,
  ILocalAgentSelection,
  LocalAgents,
} from '../../lib/local-agent'
import { IMenuItem } from '../../lib/menu-item'

/** A human readable label for an agent and model, e.g. `opencode: gpt-5`. */
export function formatLocalAgentSelection({
  agent,
  model,
}: ILocalAgentSelection) {
  return `${getLocalAgent(agent)?.name ?? agent}: ${model}`
}

/** Menu items for an agent's models, nested by group when they have one. */
export function buildModelMenu(
  agent: ILocalAgent,
  models: ReadonlyArray<ILocalAgentModel>,
  toItem: (selection: ILocalAgentSelection, label: string) => IMenuItem
): IMenuItem[] {
  const items: IMenuItem[] = []
  const groups = new Map<string, IMenuItem[]>()

  for (const model of models) {
    const item = toItem({ agent: agent.id, model: model.id }, model.label)
    if (model.group === undefined) {
      items.push(item)
      continue
    }

    let group = groups.get(model.group)
    if (group === undefined) {
      group = []
      groups.set(model.group, group)
      items.push({ label: model.group, submenu: group })
    }
    group.push(item)
  }

  return items.length > 0
    ? items
    : [{ label: 'No models available', enabled: false }]
}

/**
 * Build the full agent and model menu, with recently used selections first and
 * each agent's models (grouped by provider) below. Listing an agent's models
 * runs its CLI, so this is async.
 */
export async function buildLocalAgentMenu(
  current: ILocalAgentSelection,
  onSelect: (selection: ILocalAgentSelection) => void
): Promise<ReadonlyArray<IMenuItem>> {
  const toItem = (selection: ILocalAgentSelection, label: string) => ({
    label,
    type: 'checkbox' as const,
    checked:
      selection.agent === current.agent && selection.model === current.model,
    action: () => onSelect(selection),
  })

  const items: IMenuItem[] = getRecentLocalAgents().map(s =>
    toItem(s, formatLocalAgentSelection(s))
  )
  items.push({ type: 'separator' })

  const listings = await Promise.allSettled(
    LocalAgents.map(a => a.listModels())
  )

  LocalAgents.forEach((agent, i) => {
    const listing = listings[i]
    if (listing.status === 'rejected') {
      log.error(`Failed to list ${agent.name} models`, listing.reason)
      items.push({
        label: agent.name,
        submenu: [{ label: 'Could not list models', enabled: false }],
      })
      return
    }

    items.push({
      label: agent.name,
      submenu: buildModelMenu(agent, listing.value, toItem),
    })
  })

  return items
}

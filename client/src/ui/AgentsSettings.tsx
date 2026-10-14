/**
 * Agents tab: the local AI-agent workbench.
 *
 * Two halves:
 *  1. **Detected agents** — the server's `agent.list` scan of the machine
 *     running the daemon (name / command / availability / version).
 *  2. **Config editor** — the effective `agent.config.get` config: the
 *     default agent plus one entry per task (`AGENT_TASKS`), each with
 *     its own agent, optional skill and prompt. Save writes it through
 *     `agent.config.set`; Rescan re-runs the PATH scan.
 *
 * The scan happens once per selected repo when the tab opens (see
 * `actions.ensureAgents`) — tab toggles reuse it.
 *
 * To add another task/action: add it to `AGENT_TASKS` + `AgentTask` in
 * `api/types.ts` (and wire its RPC in `api/client.ts`), give it a label
 * in `TASK_LABELS` / `TASK_HINTS` below, then add a handler on the
 * server. No other client change is needed.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AGENT_TASKS,
  type AgentTask,
  type AgentsConfig,
  type DetectedAgent,
  type TaskConfig,
} from '../api/types'
import { useStore } from '../state/store'
import { AgentBusyLabel } from './AgentReviewButton'
import { Button, EmptyState, SelectField, Spinner, TextArea, TextInput } from './common'

const TASK_LABELS: Record<AgentTask, string> = {
  commit_message: 'Commit message',
  summarize_file: 'Summarize file',
  review: 'Review',
  comment: 'Comment',
}

const TASK_HINTS: Record<AgentTask, string> = {
  commit_message: 'Used by “✨ Generate message” in the commit composer.',
  summarize_file: 'Used by “✨ Summarize” in the file preview header.',
  review: 'Used by “✨ Review” on commits, pull requests and files.',
  comment: 'Used by “Send to agent” on file comments.',
}

/** A task entry that always exists, even when the config omits it. */
function fallbackTask(agent: string): TaskConfig {
  return { agent, skill: null, prompt: '' }
}

type Availability = 'ok' | 'unavailable' | 'unscanned'

function availabilityOf(name: string, detected: DetectedAgent[]): Availability {
  const match = detected.find((agent) => agent.name === name)
  if (!match) return 'unscanned'
  return match.available ? 'ok' : 'unavailable'
}

export function AgentsSettings() {
  const { state, actions } = useStore()
  const path = state.selectedRepoPath as string
  const config = state.agentsConfig
  const detected = state.detectedAgents

  const [draft, setDraft] = useState<AgentsConfig | null>(config)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Scan once per repo when the tab opens (Rescan forces a re-read).
  const scannedFor = useRef<string | null>(null)
  useEffect(() => {
    if (scannedFor.current === path) return
    scannedFor.current = path
    void actions.ensureAgents(path)
  }, [path, actions])

  // Re-sync the form whenever the server's config changes (the initial
  // scan, or the re-read that follows a save).
  useEffect(() => {
    setDraft(config)
  }, [config])

  const busy = state.agentsBusy !== null
  const loading = state.agentsLoading || state.agentsConfigLoading

  /** Agent names the pickers may offer: the configured set + the scan. */
  const agentNames = useMemo(() => {
    const names = new Set<string>([
      ...(draft?.agents ?? []).map((agent) => agent.name),
      ...detected.map((agent) => agent.name),
    ])
    return Array.from(names).sort((a, b) => a.localeCompare(b))
  }, [draft, detected])

  const availableCount = detected.filter((agent) => agent.available).length

  /**
   * Options for a picker, always including the value it currently holds
   * so a configured-but-unscanned agent never renders a blank select.
   */
  const optionsFor = (current: string) =>
    agentNames.includes(current) ? agentNames : [current, ...agentNames]

  const updateTask = (task: AgentTask, patch: Partial<TaskConfig>) => {
    setDraft((prev) => {
      if (!prev) return prev
      const current = prev.tasks[task] ?? fallbackTask(prev.defaultAgent)
      return { ...prev, tasks: { ...prev.tasks, [task]: { ...current, ...patch } } }
    })
    setSaved(false)
  }

  const save = async () => {
    if (!draft || saving) return
    setSaving(true)
    setSaved(false)
    const ok = await actions.saveAgentsConfig(draft)
    setSaving(false)
    if (ok) setSaved(true)
  }

  const rescan = async () => {
    if (busy) return
    setSaved(false)
    await actions.loadAgents()
  }

  if (draft === null) {
    return (
      <div className="branches">
        <section className="section-card">
          <header>
            <h3>Agents</h3>
            <span className="grow" />
            {state.agentsBusy ? (
              <AgentBusyLabel label={state.agentsBusy} />
            ) : loading ? (
              <Spinner />
            ) : null}
            <Button small variant="ghost" disabled={busy} onClick={() => void rescan()}>
              Rescan
            </Button>
          </header>
          {loading ? (
            <div className="hint" style={{ padding: '10px 12px' }} aria-busy="true">
              Scanning the server’s PATH for agent CLIs…
            </div>
          ) : state.agentsMessage ? (
            <div className="agent-setup" role="status">
              <strong>{state.agentsMessage}</strong>
              <div className="hint">
                Agent operations run the AI CLIs installed on the machine running the server —
                nothing is bundled or downloaded by the browser.
              </div>
            </div>
          ) : (
            <EmptyState icon="🤖" title="No agent configuration yet">
              The server reported no effective agents configuration.
            </EmptyState>
          )}
        </section>
      </div>
    )
  }

  return (
    <div className="branches agents-settings">
      <section className="section-card">
        <header>
          <h3>Agents</h3>
          <span className="hint">
            {availableCount} of {detected.length} detected agent
            {detected.length === 1 ? '' : 's'} available
          </span>
          <span className="grow" />
          {saved ? <span className="agent-saved">Saved</span> : null}
          {state.agentsBusy ? (
            <AgentBusyLabel label={state.agentsBusy} />
          ) : loading ? (
            <Spinner />
          ) : null}
          <Button
            small
            variant="ghost"
            disabled={busy}
            onClick={() => void rescan()}
            title="Re-scan the server's PATH and re-read the config"
          >
            Rescan
          </Button>
          <Button
            small
            variant="primary"
            disabled={busy || saving}
            busy={saving}
            onClick={() => void save()}
            title="Persist the config to the server's data dir"
          >
            Save config
          </Button>
        </header>

        <div className="agent-config-path hint">
          <span className="mono">{draft.configPath || '(config path unavailable)'}</span>
          <span className="hint"> — where “Save config” writes.</span>
        </div>

        {state.agentsMessage ? (
          <div className="agent-setup" role="status">
            <strong>{state.agentsMessage}</strong>
          </div>
        ) : null}

        {detected.length === 0 ? (
          <div className="hint" style={{ padding: '4px 12px' }} aria-busy={loading}>
            {loading
              ? 'Scanning the server’s PATH for agent CLIs…'
              : 'No agent CLIs were found on the server’s PATH.'}
          </div>
        ) : (
          <table className="agent-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Command</th>
                <th>Status</th>
                <th>Version</th>
              </tr>
            </thead>
            <tbody>
              {detected.map((agent) => (
                <tr key={agent.name}>
                  <td className="agent-name">{agent.name}</td>
                  <td className="mono hint">{agent.command}</td>
                  <td>
                    <span className={`agent-badge ${agent.available ? 'available' : 'missing'}`}>
                      {agent.available ? 'available' : 'not installed'}
                    </span>
                  </td>
                  <td className="mono hint">{agent.version ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="agent-config-editor">
          <SelectField
            label="Default agent"
            value={draft.defaultAgent}
            onChange={(e) => {
              setDraft((prev) => (prev ? { ...prev, defaultAgent: e.target.value } : prev))
              setSaved(false)
            }}
            title="The agent used when a task does not name one (informational)"
          >
            {optionsFor(draft.defaultAgent).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </SelectField>

          {AGENT_TASKS.map((task) => {
            const taskConfig = draft.tasks[task] ?? fallbackTask(draft.defaultAgent)
            const availability = availabilityOf(taskConfig.agent, detected)
            return (
              <div className="task-card" key={task}>
                <div className="task-card-head">
                  <strong>{TASK_LABELS[task]}</strong>
                  <span className="mono hint">{task}</span>
                  <span className="grow" />
                  {availability === 'unavailable' ? (
                    <span className="agent-warning" role="status">
                      ⚠ “{taskConfig.agent}” is not available on the server
                    </span>
                  ) : null}
                  {availability === 'unscanned' ? (
                    <span className="hint">no scanned agent named “{taskConfig.agent}”</span>
                  ) : null}
                </div>

                <div className="task-card-fields">
                  <SelectField
                    label="Agent"
                    value={taskConfig.agent}
                    onChange={(e) => updateTask(task, { agent: e.target.value })}
                  >
                    {optionsFor(taskConfig.agent).map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </SelectField>
                  <TextInput
                    label="Skill"
                    placeholder="(none)"
                    value={taskConfig.skill ?? ''}
                    onChange={(e) =>
                      updateTask(task, { skill: e.target.value.trim() || null })
                    }
                    title="A <name>/SKILL.md whose text is injected ahead of the prompt"
                  />
                </div>

                <TextArea
                  label="Prompt"
                  rows={4}
                  value={taskConfig.prompt}
                  onChange={(e) => updateTask(task, { prompt: e.target.value })}
                  placeholder="Guidance handed to the agent before the per-call context"
                />
                <div className="hint">{TASK_HINTS[task]}</div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

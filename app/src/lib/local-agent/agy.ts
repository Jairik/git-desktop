import { copyFile, writeFile } from 'fs/promises'
import * as os from 'os'
import * as Path from 'path'
import {
  cachedModelList,
  ChatTimeoutMs,
  findCommitMessageSkill,
  findExecutable,
  GenerationTimeoutMs,
  ILocalAgent,
  parseCommitMessage,
  runAgentCli,
  withTempDir,
} from './shared'

const EnvVar = 'AGY_BIN'

function getAgyPath() {
  return findExecutable('agy', EnvVar, [
    Path.join(os.homedir(), '.local', 'bin'),
  ])
}

/**
 * The prompt for agy. It has no way to attach files, so the diff (and the
 * skill, which agy doesn't discover from ~/.agents) are written to a temp
 * directory that's added to its workspace.
 */
function getPrompt(diffPath: string, skillPath: string | null) {
  const instructions =
    skillPath !== null
      ? `following the instructions in ${skillPath} (the generate-commit-message skill)`
      : 'as a conventional commit message (`type(scope): summary`, a blank line, then a short description)'

  return (
    `Write a commit message for the changes in ${diffPath}, ${instructions}. ` +
    'The diff is the complete set of changes being committed; read only the ' +
    'files named here. Do not run other commands, inspect the working tree, ' +
    'or modify files. Respond with only the commit message inside a single ' +
    '```commit code block.'
  )
}

/** Google Antigravity's CLI (`agy`), run in print mode. */
export const agyAgent: ILocalAgent = {
  id: 'agy',
  name: 'Antigravity',
  defaultModel: 'gemini-3.8-flash-medium',

  listModels: cachedModelList(async () => {
    const stdout = await runAgentCli('agy', EnvVar, getAgyPath(), ['models'])

    // Lines look like `<id>\t<label>`, after a "Fetching..." preamble.
    return stdout
      .split('\n')
      .map(l => l.split('\t'))
      .filter(parts => parts.length >= 2 && parts[0].trim().length > 0)
      .map(([id, label]) => ({ id: id.trim(), label: label.trim() }))
  }),

  generateCommitMessage(diff, cwd, model, signal, onProgress) {
    return withTempDir(async dir => {
      const diffPath = Path.join(dir, 'changes.diff')
      await writeFile(diffPath, diff)

      const userSkill = findCommitMessageSkill()
      let skillPath: string | null = null
      if (userSkill !== null) {
        skillPath = Path.join(dir, 'SKILL.md')
        await copyFile(userSkill, skillPath)
      }

      onProgress('Starting Antigravity')

      let draft = ''
      const stdout = await runAgentCli(
        'agy',
        EnvVar,
        getAgyPath(),
        [
          '--print',
          getPrompt(diffPath, skillPath),
          '--model',
          model,
          '--output-format',
          'stream-json',
          '--add-dir',
          dir,
        ],
        {
          cwd,
          signal,
          timeout: GenerationTimeoutMs,
          onStdoutLine: line => {
            const update = parseEvent(line)?.step_update
            if (update === undefined) {
              return
            }

            if (update.step_type === 'tool' && update.state === 'ACTIVE') {
              const path = String(update.tool_info?.parameters?.AbsolutePath)
              onProgress(
                path.endsWith('SKILL.md')
                  ? 'Reading the generate-commit-message skill'
                  : path.endsWith('changes.diff')
                  ? 'Reading the diff'
                  : `Using ${update.tool_name}`
              )
            } else if (typeof update.text_delta === 'string') {
              draft += update.text_delta
              onProgress('Writing the commit message', draft)
            } else if (update.step_type === 'agent_response') {
              onProgress('Thinking')
            }
          },
          describeFailure: findAgyError,
        }
      )

      return parseCommitMessage(extractAgyResponse(stdout))
    })
  },

  async chat({ prompt, model, cwd, signal, session, onProgress }) {
    const args = [
      '--print',
      prompt,
      '--model',
      model,
      '--output-format',
      'stream-json',
    ]

    if (session !== null) {
      args.push('--conversation', session)
    }

    onProgress('Starting Antigravity')

    // agy reports the conversation id on the first turn, we pass it back in
    // (as --conversation) to continue the same conversation.
    let conversation = session
    let draft = ''
    const stdout = await runAgentCli('agy', EnvVar, getAgyPath(), args, {
      cwd,
      signal,
      timeout: ChatTimeoutMs,
      onStdoutLine: line => {
        const event = parseEvent(line)
        if (event === null) {
          return
        }

        if (
          event.event === 'init' &&
          typeof event.conversation_id === 'string'
        ) {
          conversation = event.conversation_id
        }

        const update = event.step_update
        if (update === undefined) {
          return
        }

        if (update.step_type === 'tool' && update.state === 'ACTIVE') {
          onProgress(`Using ${update.tool_name}`, draft)
        } else if (typeof update.text_delta === 'string') {
          draft += update.text_delta
          onProgress('Writing a reply', draft)
        } else if (update.step_type === 'agent_response') {
          onProgress('Thinking', draft)
        }
      },
      describeFailure: findAgyError,
    })

    const error = findAgyError(stdout)
    if (error !== null) {
      throw new Error(`agy failed: ${error}`)
    }

    const text =
      draft.trim().length > 0 ? draft.trim() : extractAgyResponse(stdout).trim()
    if (text.length === 0) {
      throw new Error('agy did not return a reply')
    }

    return { text, session: conversation }
  },
}

function parseEvent(line: string): any {
  if (!line.trim().startsWith('{')) {
    return null
  }
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function findResult(stdout: string): any {
  for (const line of stdout.split('\n').reverse()) {
    const event = parseEvent(line)
    if (event?.event === 'result') {
      return event.result
    }
  }
  return null
}

function findAgyError(stdout: string): string | null {
  const result = findResult(stdout)
  if (result === null || result.status === 'SUCCESS') {
    return null
  }
  const detail = result.error?.message ?? result.error ?? result.status
  return typeof detail === 'string' ? detail : JSON.stringify(detail)
}

/** Pull the response out of agy's final result event. */
function extractAgyResponse(stdout: string): string {
  const result = findResult(stdout)
  if (result === null) {
    throw new Error('agy returned output that could not be parsed')
  }

  const error = findAgyError(stdout)
  if (error !== null) {
    throw new Error(`agy failed: ${error}`)
  }

  if (typeof result.response !== 'string' || !result.response.trim()) {
    throw new Error('agy did not return a commit message')
  }

  return result.response
}

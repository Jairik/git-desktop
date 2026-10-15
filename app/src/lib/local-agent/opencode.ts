import { writeFile } from 'fs/promises'
import * as os from 'os'
import * as Path from 'path'
import {
  cachedModelList,
  ChatTimeoutMs,
  findExecutable,
  GenerationTimeoutMs,
  ILocalAgent,
  LocalAgentProgressCallback,
  parseCommitMessage,
  runAgentCli,
  withTempDir,
} from './shared'

const EnvVar = 'OPENCODE_BIN'

const CommitMessagePrompt =
  'Use the generate-commit-message skill to write a commit message for ' +
  'the changes in the attached diff only. The diff is the complete set of ' +
  'changes being committed; do not run commands, inspect the working tree, ' +
  'or modify files. Respond with only the commit message inside a single ' +
  '```commit code block.'

function getOpencodePath() {
  return findExecutable('opencode', EnvVar, [
    Path.join(os.homedir(), '.opencode', 'bin'),
  ])
}

/** opencode (https://opencode.ai), which loads the skill by itself. */
export const opencodeAgent: ILocalAgent = {
  id: 'opencode',
  name: 'opencode',
  defaultModel: 'opencode-go/deepseek-v4.1-flash',

  listModels: cachedModelList(async () => {
    const stdout = await runAgentCli('opencode', EnvVar, getOpencodePath(), [
      'models',
    ])

    return stdout
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.includes('/'))
      .map(id => {
        const slash = id.indexOf('/')
        return {
          id,
          label: id.substring(slash + 1),
          group: id.substring(0, slash),
        }
      })
  }),

  generateCommitMessage(diff, cwd, model, signal, onProgress) {
    return withTempDir(async dir => {
      const diffPath = Path.join(dir, 'changes.diff')
      await writeFile(diffPath, diff)

      onProgress('Starting opencode')

      const stdout = await runAgentCli(
        'opencode',
        EnvVar,
        getOpencodePath(),
        [
          'run',
          '--format',
          'json',
          '--model',
          model,
          '--title',
          'GitHub Desktop commit message',
          '--file',
          diffPath,
          CommitMessagePrompt,
        ],
        {
          cwd,
          signal,
          timeout: GenerationTimeoutMs,
          onStdoutLine: line => reportProgress(line, onProgress),
          describeFailure: findOpencodeError,
        }
      )

      const error = findOpencodeError(stdout)
      if (error !== null) {
        throw new Error(`opencode failed: ${error}`)
      }

      return parseCommitMessage(extractOpencodeText(stdout))
    })
  },

  async chat({ prompt, model, cwd, signal, session, onProgress }) {
    // opencode creates the session on first use when the id is unknown, and
    // requires ids to start with 'ses'.
    const id = session ?? `ses_${crypto.randomUUID().replace(/-/g, '')}`

    onProgress('Starting opencode')

    let draft = ''
    const stdout = await runAgentCli(
      'opencode',
      EnvVar,
      getOpencodePath(),
      ['run', '--format', 'json', '--model', model, '--session', id, prompt],
      {
        cwd,
        signal,
        timeout: ChatTimeoutMs,
        onStdoutLine: line => {
          draft = reportChatProgress(line, draft, onProgress)
        },
        describeFailure: findOpencodeError,
      }
    )

    const error = findOpencodeError(stdout)
    if (error !== null) {
      throw new Error(`opencode failed: ${error}`)
    }

    const text = draft.trim()
    if (text.length === 0) {
      throw new Error('opencode did not return a reply')
    }

    return { text, session: id }
  },
}

/** Parse the JSON events opencode prints, one per line. */
function parseEvents(stdout: string): any[] {
  const events = []
  for (const line of stdout.split('\n')) {
    const event = parseEvent(line)
    if (event !== null) {
      events.push(event)
    }
  }
  return events
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

/** Turn opencode's event stream into status updates. */
function reportProgress(line: string, onProgress: LocalAgentProgressCallback) {
  const event = parseEvent(line)
  if (event === null) {
    return
  }

  if (event.type === 'step_start') {
    onProgress('Thinking')
  } else if (event.type === 'tool_use') {
    const tool = event.part?.tool
    if (tool === 'skill') {
      onProgress('Loaded the generate-commit-message skill')
    } else if (tool === 'read') {
      onProgress('Reading the diff')
    } else if (typeof tool === 'string') {
      onProgress(`Using ${tool}`)
    }
  } else if (event.type === 'text') {
    onProgress('Writing the commit message')
  }
}

/**
 * Fold one opencode event into a chat status update. Returns the reply text
 * seen so far, which is streamed as the draft and used as the final reply.
 */
function reportChatProgress(
  line: string,
  draft: string,
  onProgress: LocalAgentProgressCallback
): string {
  const event = parseEvent(line)
  if (event === null) {
    return draft
  }

  if (event.type === 'step_start') {
    onProgress('Thinking', draft)
  } else if (event.type === 'tool_use') {
    const tool = event.part?.tool
    if (typeof tool === 'string') {
      onProgress(`Using ${tool}`, draft)
    }
  } else if (event.type === 'text' && typeof event.part?.text === 'string') {
    draft =
      draft.length > 0 ? `${draft}\n\n${event.part.text}` : event.part.text
    onProgress('Writing a reply', draft)
  }

  return draft
}

function findOpencodeError(stdout: string): string | null {
  const event = parseEvents(stdout).find(e => e.type === 'error')
  if (event === undefined) {
    return null
  }

  const { error } = event
  const message = error?.data?.message ?? error?.message ?? error?.name
  return typeof message === 'string' ? message : 'unknown error'
}

/** The assistant's final reply from opencode's event stream. */
function extractOpencodeText(stdout: string): string {
  const texts = parseEvents(stdout)
    .filter(e => e.type === 'text' && typeof e.part?.text === 'string')
    .map(e => e.part.text as string)

  const text = texts.length > 0 ? texts[texts.length - 1] : ''
  if (text.trim().length === 0) {
    throw new Error('opencode did not return a commit message')
  }

  return text
}

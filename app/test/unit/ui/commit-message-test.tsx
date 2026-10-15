import assert from 'node:assert'
import { describe, it } from 'node:test'
import * as React from 'react'

import { Account } from '../../../src/models/account'
import { DefaultCommitMessage } from '../../../src/models/commit-message'
import { DiffSelection, DiffSelectionType } from '../../../src/models/diff'
import { GitHubRepository } from '../../../src/models/github-repository'
import { Owner } from '../../../src/models/owner'
import { RepoRulesInfo } from '../../../src/models/repo-rules'
import { Repository } from '../../../src/models/repository'
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
} from '../../../src/models/status'
import { CommitMessage } from '../../../src/ui/changes/commit-message'
import { ILocalAgentSelection } from '../../../src/lib/local-agent'

type CommitMessageProps = React.ComponentProps<typeof CommitMessage>
type ButtonProps = {
  readonly ariaLabel?: string
  readonly disabled?: boolean
}

type CommitMessageTestInstance = {
  state: CommitMessage['state']
  readonly isShowingLocalAgentStatus: boolean
  readonly renderLocalAgentButton: () => React.ReactElement | null
  readonly onLocalAgentButtonClick: (
    event: Pick<React.MouseEvent<HTMLButtonElement>, 'preventDefault'>
  ) => void
}

function createAccount() {
  return new Account(
    'mona',
    'https://api.github.com',
    'token',
    [],
    '',
    1,
    'Mona Lisa',
    'free',
    'https://copilot-proxy.githubusercontent.com',
    true,
    ['desktop_copilot_generate_commit_message']
  )
}

function createRepository() {
  const owner = new Owner('octocat', 'https://api.github.com', 1)
  const gitHubRepository = new GitHubRepository(
    'desktop',
    owner,
    99,
    false,
    'https://github.com/octocat/desktop'
  )

  return new Repository('/tmp/desktop-fixture', 123, gitHubRepository, false)
}

function createSelectedFile(path: string) {
  return new WorkingDirectoryFileChange(
    path,
    { kind: AppFileStatusKind.Modified },
    DiffSelection.fromInitialSelection(DiffSelectionType.All)
  )
}

function createProps(
  overrides: Partial<CommitMessageProps> = {}
): CommitMessageProps {
  const account = createAccount()
  const repository = createRepository()
  const filesSelected = [createSelectedFile('src/index.ts')]

  return {
    onCreateCommit: async () => false,
    branch: 'main',
    commitAuthor: null,
    anyFilesSelected: true,
    filesToBeCommittedCount: filesSelected.length,
    showPromptForCommittingFileHiddenByFilter: false,
    isShowingModal: false,
    isShowingFoldout: false,
    anyFilesAvailable: true,
    filesSelected,
    focusCommitMessage: false,
    commitMessage: DefaultCommitMessage,
    repository,
    repositoryAccount: null,
    autocompletionProviders: [],
    isCommitting: false,
    hookProgress: null,
    onShowCommitProgress: undefined,
    isGeneratingCommitMessage: true,
    commitToAmend: null,
    placeholder: 'Summary',
    prepopulateCommitSummary: false,
    showBranchProtected: false,
    repoRulesInfo: new RepoRulesInfo(),
    aheadBehind: null,
    showNoWriteAccess: false,
    showCoAuthoredBy: false,
    showInputLabels: false,
    coAuthors: [],
    shouldNudge: false,
    commitSpellcheckEnabled: false,
    showCommitLengthWarning: false,
    mostRecentLocalCommit: null,
    onCoAuthorsUpdated: () => {},
    onShowCoAuthoredByChanged: () => {},
    onConfirmCommitWithUnknownCoAuthors: () => {},
    onGenerateCommitMessageWithLocalAgent: () => {},
    onCancelGenerateCommitMessage: () => {},
    onCommitMessageFocusSet: () => {},
    onRefreshAuthor: () => {},
    onShowPopup: () => {},
    onShowFoldout: () => {},
    onCommitSpellcheckEnabledChanged: () => {},
    onStopAmending: () => {},
    onShowCreateForkDialog: () => {},
    accounts: [account],
    skipCommitHooks: false,
    signOffCommits: false,
    allowEmptyCommit: false,
    showAllowEmptyCommitOption: true,
    onUpdateCommitOptions: () => {},
    ...overrides,
  }
}

function toTestInstance(component: CommitMessage): CommitMessageTestInstance {
  return component as unknown as CommitMessageTestInstance
}

function isElementWithButtonProps(
  node: React.ReactNode
): node is React.ReactElement<ButtonProps & { readonly className?: string }> {
  return (
    React.isValidElement(node) &&
    (node.props as { className?: string }).className === 'local-agent-button'
  )
}

function getLocalAgentButtonProps(
  component: CommitMessageTestInstance
): ButtonProps {
  const button = component.renderLocalAgentButton()
  if (button === null) {
    throw new Error('Expected local agent button to render')
  }

  const buttonElement = React.Children.toArray(
    (button.props as { children?: React.ReactNode }).children
  ).find(isElementWithButtonProps)
  if (buttonElement === undefined) {
    throw new Error('Expected local agent button element to render')
  }

  return buttonElement.props
}

function clickLocalAgentButton(component: CommitMessageTestInstance) {
  component.onLocalAgentButtonClick({ preventDefault: () => {} })
}

describe('CommitMessage', () => {
  it('generates with the selected local agent when idle', () => {
    const calls: ILocalAgentSelection[] = []
    const component = toTestInstance(
      new CommitMessage(
        createProps({
          isGeneratingCommitMessage: false,
          onGenerateCommitMessageWithLocalAgent: (_files, selection) => {
            calls.push(selection)
          },
        })
      )
    )

    assert.equal(getLocalAgentButtonProps(component).disabled, false)

    clickLocalAgentButton(component)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].agent, 'opencode')
  })

  it('disables the button when there is nothing to generate from', () => {
    const component = toTestInstance(
      new CommitMessage(
        createProps({
          isGeneratingCommitMessage: false,
          filesSelected: [],
          commitToAmend: null,
        })
      )
    )

    assert.equal(getLocalAgentButtonProps(component).disabled, true)
  })

  it('offers to cancel an in-flight generation', () => {
    let cancelCount = 0
    const component = toTestInstance(
      new CommitMessage(
        createProps({
          isGeneratingCommitMessage: true,
          onCancelGenerateCommitMessage: () => {
            cancelCount++
          },
        })
      )
    )

    const buttonProps = getLocalAgentButtonProps(component)
    assert.equal(buttonProps.ariaLabel, 'Cancel generating commit details')
    assert.equal(buttonProps.disabled, false)

    clickLocalAgentButton(component)

    assert.equal(cancelCount, 1)
  })

  it('shows the agent status while a generation is in flight', () => {
    const component = toTestInstance(
      new CommitMessage(createProps({ isGeneratingCommitMessage: true }))
    )

    // Nothing has been reported by the agent yet
    assert.equal(component.isShowingLocalAgentStatus, false)

    component.state = {
      ...component.state,
      localAgentStatus: {
        repositoryPath: '/tmp/desktop-fixture',
        agentName: 'opencode',
        model: 'opencode-go/deepseek-v4.1-flash',
        message: 'Thinking',
        detail: null,
        draft: null,
        startedAt: Date.now(),
      },
    }

    assert.equal(component.isShowingLocalAgentStatus, true)
  })
})

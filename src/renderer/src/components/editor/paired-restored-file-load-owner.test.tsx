// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { buildMirroredEditorTabs } from '@/runtime/web-session-tabs-sync/tab-builders'
import { buildWebSessionExistingTabIndex } from '@/runtime/web-session-existing-tab-index'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import {
  useEditorPanelFileContentLoader,
  type EditorPanelFileContentLoader
} from './useEditorPanelFileContentLoader'

const mocks = vi.hoisted(() => ({ getState: vi.fn(), read: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('./csv/csv-file-content', () => ({ readEditorCsvFileContent: mocks.read }))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: () => undefined,
  isWorktreeConnectionResolved: () => true
}))
vi.mock('@/lib/worktree-host-connection-phase', () => import('./local-host-test-fixture'))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const WORKTREE = 'client-repo::workspace'
const FILE: OpenFile = {
  id: 'restored-file',
  filePath: '/fixture/client/legacy.txt',
  relativePath: 'legacy.txt',
  worktreeId: WORKTREE,
  language: 'plaintext',
  mode: 'edit',
  isDirty: false
}

describe('restored file loads while another paired desktop is selected', () => {
  let root: Root
  let container: HTMLDivElement
  let load: EditorPanelFileContentLoader
  let contents: Record<string, FileContent>
  let files: OpenFile[]

  beforeEach(() => {
    mocks.read.mockReset()
    contents = {}
    files = [{ ...FILE }]
    mocks.getState.mockImplementation(() => ({
      settings: { activeRuntimeEnvironmentId: 'paired-host' },
      repos: [{ id: 'client-repo', executionHostId: 'local' }],
      worktreesByRepo: {
        'client-repo': [{ id: WORKTREE, repoId: 'client-repo', hostId: 'local' }]
      },
      openFiles: files,
      setLastKnownDiskSignature: vi.fn()
    }))
    mocks.read.mockImplementation(async ({ target }: { target: RuntimeClientTarget }) => {
      if (target.kind === 'environment' && target.environmentId === 'paired-host') {
        throw new RuntimeRpcCallError({
          id: 'fixture-wrong-host-read',
          ok: false,
          error: { code: 'selector_not_found', message: 'Selector not found' }
        })
      }
      return { content: 'CLIENT_FILE_CONTENT', isBinary: false }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    function Probe(): null {
      load = useEditorPanelFileContentLoader({
        fileLoadRetryAttemptsRef: { current: {} },
        fileReadGenerationCounterRef: { current: 0 },
        fileReadGenerationRef: { current: {} },
        outstandingFileReadsRef: { current: {} },
        openFilesRef: { current: files },
        setFileContents: (update) => {
          contents = typeof update === 'function' ? update(contents) : update
        }
      })
      return null
    }
    act(() => root.render(<Probe />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('reads a legacy unstamped local file on its workspace owner, including Retry', async () => {
    await act(async () => load(FILE.filePath, FILE.id, WORKTREE, FILE.relativePath))
    await act(async () => load(FILE.filePath, FILE.id, WORKTREE, FILE.relativePath))

    expect(mocks.read).toHaveBeenCalledTimes(2)
    for (const [request] of mocks.read.mock.calls) {
      expect(request).toMatchObject({ target: { kind: 'local' }, worktreeId: WORKTREE })
    }
    expect(contents[FILE.id]).toMatchObject({ content: 'CLIENT_FILE_CONTENT' })
  })

  it('preserves an explicit local stamp while the paired host is selected', async () => {
    files[0].runtimeEnvironmentId = null
    await act(async () => load(FILE.filePath, FILE.id, WORKTREE, FILE.relativePath))
    expect(mocks.read.mock.calls[0]?.[0]).toMatchObject({ target: { kind: 'local' } })
  })

  it('keeps a mirror stamp authoritative when its host rejects the workspace selector', async () => {
    files[0].runtimeEnvironmentId = 'mirror-owner'
    files[0].mirroredFromRuntimeSession = true
    mocks.read.mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'fixture-read',
        ok: false,
        error: { code: 'selector_not_found', message: 'Selector not found' }
      })
    )

    await act(async () => load(FILE.filePath, FILE.id, WORKTREE, FILE.relativePath))
    expect(mocks.read.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: 'environment', environmentId: 'mirror-owner' },
      worktreeId: WORKTREE
    })
    expect(contents[FILE.id]).toMatchObject({ loadErrorCode: 'selector_not_found' })
    expect(files).toEqual([
      { ...FILE, runtimeEnvironmentId: 'mirror-owner', mirroredFromRuntimeSession: true }
    ])
  })

  it('records a republished local workspace file stamped as the publishing paired host', async () => {
    const [mirror] = buildMirroredEditorTabs(
      {
        worktree: WORKTREE,
        publicationEpoch: 'fixture-epoch',
        snapshotVersion: 1,
        activeGroupId: 'fixture-group',
        activeTabId: 'republished-tab',
        activeTabType: 'file',
        tabs: [
          {
            type: 'file',
            id: 'republished-tab',
            title: 'legacy.txt',
            filePath: FILE.filePath,
            relativePath: FILE.relativePath,
            language: FILE.language,
            isDirty: false,
            isActive: true
          }
        ]
      },
      'paired-host',
      [],
      buildWebSessionExistingTabIndex({ unifiedTabs: [] }),
      new Map(),
      'fixture-group',
      0,
      1,
      () => false
    )
    if (!mirror) {
      throw new Error('Fixture mirror was not built')
    }
    files[0] = mirror.file
    expect(mirror.file).toMatchObject({
      worktreeId: WORKTREE,
      runtimeEnvironmentId: 'paired-host',
      mirroredFromRuntimeSession: true
    })
    await act(async () => load(FILE.filePath, mirror.file.id, WORKTREE, FILE.relativePath))
    expect(mocks.read.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: 'environment', environmentId: 'paired-host' },
      worktreeId: WORKTREE
    })
    expect(contents[mirror.file.id]).toMatchObject({ loadErrorCode: 'selector_not_found' })
  })
})
